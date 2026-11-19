// graphql.ts — the GraphQL v4 surface: a small parser and executor covering the documents gh
// and github-mcp-server actually send (viewer, repository reads, issue/pull connections with
// cursor pagination, the five mutations, node(id:), and __type introspection). It executes
// against the same store as REST, git and MCP, and answers unknown fields the way GraphQL
// does: HTTP 200, partial data, and an errors array naming the field.

import {
  branchRef,
  pullFiles,
  pullMergeable,
  resolveRef,
  store,
  type IssueRecord,
  type PullRecord,
  type Repo,
} from './store.ts';
import { createIssueRecord, createPullRecord, mergePullRecord } from './rest.ts';

// ----------------------------------------------------------------------------------------------
// Global ids: opaque, stable, and never the plain database number.
// ----------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`repo:${repo.dbId}`).toString('base64');
}

export function issueGlobalId(repo: Repo, issue: IssueRecord): string {
  return Buffer.from(`issue:${repo.dbId}:${issue.number}`).toString('base64');
}

export function pullGlobalId(repo: Repo, pull: PullRecord): string {
  return Buffer.from(`pr:${repo.dbId}:${pull.number}`).toString('base64');
}

export function commentGlobalId(id: number): string {
  return Buffer.from(`comment:${id}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoByDbId(dbId: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

// ----------------------------------------------------------------------------------------------
// Tokenizer and parser for the GraphQL subset the suite's documents use.
// ----------------------------------------------------------------------------------------------

type Token = { kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) { at += 1; continue; }
    if (source.startsWith('...', at)) { tokens.push({ kind: 'spread', value: '...' }); at += 3; continue; }
    if ('!$():=@[]{}|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); at += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        tokens.push({ kind: 'string', value: source.slice(at + 3, end === -1 ? source.length : end) });
        at = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at))!;
      tokens.push({ kind: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', value: match[0] });
      at += match[0].length;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
    if (name !== null) {
      tokens.push({ kind: 'name', value: name[0] });
      at += name[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private at = 0;
  readonly fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of the GraphQL document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipBalanced(): void {
    // Variable definitions and directives: skip a parenthesized group.
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.at < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${token.value}`);
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced();
        // Directives before the selection set.
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced();
        }
        operations.push({ operation: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.next(); // 'on'
        this.next(); // type condition
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        const head = this.peek();
        if (head?.kind === 'name' && head.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next().value });
        }
        continue;
      }
      // A field, possibly aliased.
      let name = this.next().value;
      let alias: string | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = new Map<string, Value>();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        for (;;) {
          const closing = this.peek();
          if (closing?.kind === 'punct' && closing.value === ')') { this.next(); break; }
          const argName = this.next().value;
          this.expectPunct(':');
          args.set(argName, this.parseValue());
        }
      }
      // Field directives: parsed and ignored.
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        this.next();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalanced();
      }
      let selection: SelectionNode[] | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selection });
    }
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      for (;;) {
        const closing = this.peek();
        if (closing?.kind === 'punct' && closing.value === ']') { this.next(); break; }
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      for (;;) {
        const closing = this.peek();
        if (closing?.kind === 'punct' && closing.value === '}') { this.next(); break; }
        const name = this.next().value;
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Resolve a parsed Value against the request's variables into plain JSON data. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ----------------------------------------------------------------------------------------------
// The schema: type -> field names (for introspection and validation), and enum values.
// ----------------------------------------------------------------------------------------------

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'repository', 'comments',
    'createdAt', 'updatedAt', 'closed', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'additions', 'deletions', 'changedFiles',
    'createdAt', 'updatedAt', 'mergedAt', 'url',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  AddCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueClosedStateReason: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'],
};

// ----------------------------------------------------------------------------------------------
// Typed values and field resolution.
// ----------------------------------------------------------------------------------------------

interface Typed {
  type: string;
  repo?: Repo;
  issue?: IssueRecord;
  pull?: PullRecord;
  comment?: { id: number; body: string; seq: number };
  file?: { path: string; additions: number; deletions: number; status: string };
  items?: Typed[];
  total?: number;
  pageInfo?: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  cursor?: string;
  typeName?: string;
  scalar?: unknown;
}

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

const userTyped = (): Typed => ({ type: 'User' });

function issueTyped(repo: Repo, issue: IssueRecord): Typed {
  return { type: 'Issue', repo, issue };
}

function pullTyped(repo: Repo, pull: PullRecord): Typed {
  return { type: 'PullRequest', repo, pull };
}

function cursorFor(kind: string, key: number): string {
  return Buffer.from(`cursor:${kind}:${key}`).toString('base64');
}

function keyFromCursor(kind: string, cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = new RegExp(`^cursor:${kind}:(-?\\d+)$`).exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  wrap: (item: T) => Typed;
  keyOf: (item: T) => number;
  kind: string;
  connectionType: string;
  edgeType: string;
}

/** Slice a connection page out of an ordered item list, honoring first/after. */
function connection<T>(spec: ConnectionSpec<T>, args: Map<string, unknown>): Typed {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : spec.items.length;
  const afterKey = keyFromCursor(spec.kind, args.get('after'));
  let start = 0;
  if (afterKey !== null) {
    const index = spec.items.findIndex((item) => spec.keyOf(item) === afterKey);
    if (index !== -1) start = index + 1;
  }
  const page = spec.items.slice(start, start + Math.max(0, first));
  const nodes = page.map(spec.wrap);
  const typed: Typed = {
    type: spec.connectionType,
    items: nodes.map((node, index) => ({ ...node, cursor: cursorFor(spec.kind, spec.keyOf(page[index]!)) })),
    total: spec.items.length,
    pageInfo: {
      hasNextPage: start + page.length < spec.items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(spec.kind, spec.keyOf(page[0]!)) : null,
      endCursor: page.length > 0 ? cursorFor(spec.kind, spec.keyOf(page[page.length - 1]!)) : null,
    },
  };
  // Edges are built on demand from the same page (see resolveField's connection handling).
  typed.scalar = { edgeType: spec.edgeType, kind: spec.kind, keys: page.map(spec.keyOf) };
  return typed;
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field of a typed value to a raw value (scalar, Typed, Typed[], or null). */
function resolveField(ctx: ExecContext, source: Typed, field: string, args: Map<string, unknown>): unknown {
  const repo = source.repo;
  switch (source.type) {
    case 'User':
      if (field === 'id') return Buffer.from('user:1').toString('base64');
      if (field === 'login') return store.viewerLogin();
      if (field === 'name') return store.viewerLogin();
      if (field === 'email') return `${store.viewerLogin()}@example.invalid`;
      if (field === 'url' || field === 'avatarUrl') return '';
      break;
    case 'Repository': {
      if (repo === undefined) break;
      switch (field) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewerLogin()}/${repo.name}`;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'owner': return userTyped();
        case 'defaultBranchRef': return { type: 'Ref', scalar: repo.defaultBranch } satisfies Typed;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasWikiEnabled': return false;
        case 'createdAt': return store.iso(repo.createdSeq);
        case 'updatedAt': return store.iso(repo.createdSeq);
        case 'url': return '';
        case 'issue': {
          const number = args.get('number');
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueTyped(repo, issue);
        }
        case 'pullRequest': {
          const number = args.get('number');
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullTyped(repo, pull);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction === 'ASC' ? 'ASC' : 'DESC';
          const field2 = orderBy?.field ?? 'CREATED_AT';
          issues.sort((a, b) => {
            let cmp = 0;
            if (field2 === 'UPDATED_AT') cmp = a.updatedSeq - b.updatedSeq || a.number - b.number;
            else if (field2 === 'COMMENTS') cmp = a.comments.length - b.comments.length || a.number - b.number;
            else cmp = a.number - b.number;
            return direction === 'DESC' ? -cmp : cmp;
          });
          return connection({
            items: issues,
            wrap: (issue) => issueTyped(repo, issue),
            keyOf: (issue) => issue.number,
            kind: 'issue',
            connectionType: 'IssueConnection',
            edgeType: 'IssueEdge',
          }, args);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state)));
            pulls = pulls.filter((pull) => wanted.has(pullState(pull)));
          } else {
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => a.number - b.number);
          return connection({
            items: pulls,
            wrap: (pull) => pullTyped(repo, pull),
            keyOf: (pull) => pull.number,
            kind: 'pr',
            connectionType: 'PullRequestConnection',
            edgeType: 'PullRequestEdge',
          }, args);
        }
      }
      break;
    }
    case 'Ref':
      if (field === 'name') return source.scalar;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') return null;
      break;
    case 'Issue': {
      const issue = source.issue!;
      switch (field) {
        case 'id': return issueGlobalId(repo!, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userTyped();
        case 'repository': return { type: 'Repository', repo } satisfies Typed;
        case 'closed': return issue.state === 'closed';
        case 'createdAt': return store.iso(issue.createdSeq);
        case 'updatedAt': return store.iso(issue.updatedSeq);
        case 'url': return '';
        case 'comments':
          return connection({
            items: issue.comments,
            wrap: (comment) => ({ type: 'IssueComment', repo, comment } satisfies Typed),
            keyOf: (comment) => comment.id,
            kind: 'comment',
            connectionType: 'IssueCommentConnection',
            edgeType: 'IssueCommentEdge',
          }, args);
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.pull!;
      switch (field) {
        case 'id': return pullGlobalId(repo!, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state === 'open' ? (pullMergeable(repo!, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { type: 'Ref', scalar: pull.headRef } satisfies Typed;
        case 'baseRef': return { type: 'Ref', scalar: pull.baseRef } satisfies Typed;
        case 'author': return userTyped();
        case 'repository': return { type: 'Repository', repo } satisfies Typed;
        case 'createdAt': return store.iso(pull.createdSeq);
        case 'updatedAt': return store.iso(pull.updatedSeq);
        case 'mergedAt': return pull.mergedSeq === null ? null : store.iso(pull.mergedSeq);
        case 'url': return '';
        case 'additions': return pullFiles(repo!, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return pullFiles(repo!, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return pullFiles(repo!, pull).length;
        case 'files':
          return connection({
            items: pullFiles(repo!, pull),
            wrap: (file) => ({ type: 'PullRequestChangedFile', repo, file } satisfies Typed),
            keyOf: (_file, index) => index,
            kind: 'file',
            connectionType: 'PullRequestChangedFileConnection',
            edgeType: 'PullRequestChangedFileEdge',
          }, args);
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = source.file!;
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      if (field === 'changeType') return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      break;
    }
    case 'IssueComment': {
      const comment = source.comment!;
      if (field === 'id') return commentGlobalId(comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return userTyped();
      if (field === 'createdAt' || field === 'updatedAt') return store.iso(comment.seq);
      break;
    }
    case 'PageInfo': {
      const info = source.pageInfo!;
      if (field === 'hasNextPage') return info.hasNextPage;
      if (field === 'hasPreviousPage') return info.hasPreviousPage;
      if (field === 'startCursor') return info.startCursor;
      if (field === 'endCursor') return info.endCursor;
      break;
    }
    case '__Type': {
      const name = source.typeName!;
      if (field === 'name') return name;
      if (field === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = OBJECT_FIELDS[name];
        if (fields === undefined) return null;
        return fields.map((fieldName) => ({ type: '__Field', scalar: fieldName } satisfies Typed));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[name];
        if (values === undefined) return null;
        return values.map((valueName) => ({ type: '__EnumValue', scalar: valueName } satisfies Typed));
      }
      if (field === 'possibleTypes' || field === 'inputFields') return null;
      if (field === 'ofType') return null;
      break;
    }
    case '__Field':
      if (field === 'name') return source.scalar;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { type: '__Type', typeName: 'String' } satisfies Typed;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    case '__EnumValue':
      if (field === 'name') return source.scalar;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
  }
  // Connections and edges share generic handling.
  if (source.type.endsWith('Connection')) {
    if (field === 'nodes') return source.items ?? [];
    if (field === 'totalCount') return source.total ?? 0;
    if (field === 'pageInfo') return { type: 'PageInfo', pageInfo: source.pageInfo } satisfies Typed;
    if (field === 'edges') {
      const meta = source.scalar as { edgeType: string; kind: string; keys: number[] };
      return (source.items ?? []).map((node, index) => ({
        type: meta.edgeType,
        repo: node.repo,
        issue: node.issue,
        pull: node.pull,
        comment: node.comment,
        file: node.file,
        cursor: cursorFor(meta.kind, meta.keys[index]!),
        scalar: node,
      } satisfies Typed));
    }
  }
  if (source.type.endsWith('Edge')) {
    if (field === 'cursor') return source.cursor ?? '';
    if (field === 'node') return source.scalar as Typed;
  }
  if (source.type === 'AddCommentPayload' && field === 'commentEdge') return source.scalar as Typed;
  if (source.type === 'AddCommentEdge') {
    if (field === 'node') return source.scalar as Typed;
    if (field === 'cursor') return '';
  }
  if (source.type.endsWith('Payload')) {
    if (field === 'clientMutationId') return null;
    if (field === 'issue') return source.issue !== undefined && source.repo !== undefined ? issueTyped(source.repo, source.issue) : null;
    if (field === 'pullRequest') return source.pull !== undefined && source.repo !== undefined ? pullTyped(source.repo, source.pull) : null;
    if (field === 'subject') return source.scalar as Typed ?? null;
  }
  return undefined;
}

// ----------------------------------------------------------------------------------------------
// Execution.
// ----------------------------------------------------------------------------------------------

function executeSelection(ctx: ExecContext, source: Typed, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.type) {
        Object.assign(out, executeSelection(ctx, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelection(ctx, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, source, selection);
  }
  return out;
}

function executeField(ctx: ExecContext, source: Typed, field: FieldNode): unknown {
  const typeFields = OBJECT_FIELDS[source.type];
  const args = new Map<string, unknown>();
  for (const [name, value] of field.args) args.set(name, resolveValue(value, ctx.variables));

  if (field.name === '__type' && (source.type === 'Query' || source.type === 'Mutation')) {
    const name = args.get('name');
    if (typeof name === 'string' && (OBJECT_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined)) {
      return completeValue(ctx, { type: '__Type', typeName: name }, field.selection);
    }
    return null;
  }
  if (field.name === '__typename') return source.type;

  if (typeFields === undefined || !typeFields.includes(field.name)) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.type}'` });
    return null;
  }
  const raw = resolveField(ctx, source, field.name, args);
  if (raw === undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.type}'` });
    return null;
  }
  return completeValue(ctx, raw, field.selection);
}

function completeValue(ctx: ExecContext, raw: unknown, selection: SelectionNode[] | null): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry) => completeValue(ctx, entry, selection));
  if (typeof raw === 'object') {
    const typed = raw as Typed;
    if (selection === null) return null;
    return executeSelection(ctx, typed, selection);
  }
  return raw;
}

// ----------------------------------------------------------------------------------------------
// Root operations.
// ----------------------------------------------------------------------------------------------

function executeOperation(operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, SelectionNode[]>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: ExecContext = { variables, fragments, errors: [] };
  const data: Record<string, unknown> = {};

  if (operation.operation === 'query') {
    const root: Typed = { type: 'Query' };
    for (const selection of operation.selection) {
      if (selection.kind !== 'field') {
        Object.assign(data, executeSelection(ctx, root, [selection]));
        continue;
      }
      const key = selection.alias ?? selection.name;
      const args = new Map<string, unknown>();
      for (const [name, value] of selection.args) args.set(name, resolveValue(value, ctx.variables));
      if (selection.name === 'viewer') {
        data[key] = completeValue(ctx, userTyped(), selection.selection);
      } else if (selection.name === 'repository') {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        store.adoptLogin(owner);
        const repo = owner === store.viewerLogin() ? store.repos.get(name) ?? null : null;
        data[key] = repo === null ? null : completeValue(ctx, { type: 'Repository', repo }, selection.selection);
      } else if (selection.name === 'node') {
        data[key] = completeNode(ctx, String(args.get('id') ?? ''), selection);
      } else if (selection.name === '__type') {
        data[key] = executeField(ctx, root, selection);
      } else if (selection.name === '__typename') {
        data[key] = 'Query';
      } else {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Query'` });
        data[key] = null;
      }
    }
    return { data, errors: ctx.errors };
  }

  // Mutations.
  const root: Typed = { type: 'Mutation' };
  for (const selection of operation.selection) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    const args = new Map<string, unknown>();
    for (const [name, value] of selection.args) args.set(name, resolveValue(value, ctx.variables));
    const input = (args.get('input') ?? {}) as Record<string, unknown>;
    try {
      data[key] = executeMutation(ctx, selection, input);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'mutation failed' });
      data[key] = null;
    }
    void root;
  }
  return { data, errors: ctx.errors };
}

function completeNode(ctx: ExecContext, id: string, selection: FieldNode): unknown {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'repo') {
    const repo = repoByDbId(Number(decoded.parts[0]));
    return repo === null ? null : completeValue(ctx, { type: 'Repository', repo }, selection.selection);
  }
  if (decoded.kind === 'issue') {
    const repo = repoByDbId(Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    return repo === null || issue === undefined ? null : completeValue(ctx, issueTyped(repo, issue), selection.selection);
  }
  if (decoded.kind === 'pr') {
    const repo = repoByDbId(Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    return repo === null || pull === undefined ? null : completeValue(ctx, pullTyped(repo, pull), selection.selection);
  }
  if (decoded.kind === 'user') return completeValue(ctx, userTyped(), selection.selection);
  return null;
}

function executeMutation(ctx: ExecContext, selection: FieldNode, input: Record<string, unknown>): unknown {
  switch (selection.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo' ? repoByDbId(Number(decoded.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return completeValue(ctx, { type: 'CreateIssuePayload', repo, issue } satisfies Typed, selection.selection);
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded?.kind === 'issue' ? repoByDbId(Number(decoded.parts[0])) : null;
      const issue = repo?.issues.get(Number(decoded?.parts[1]));
      if (repo === null || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedSeq = store.tick();
      return completeValue(ctx, { type: 'CloseIssuePayload', repo, issue } satisfies Typed, selection.selection);
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.kind === 'repo' ? repoByDbId(Number(decoded.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      if (!repo.refs.has(branchRef(head))) throw new Error(`head branch ${head} does not exist`);
      if (!repo.refs.has(branchRef(base))) throw new Error(`base branch ${base} does not exist`);
      const pull = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return completeValue(ctx, { type: 'CreatePullRequestPayload', repo, pull } satisfies Typed, selection.selection);
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded?.kind === 'pr' ? repoByDbId(Number(decoded.parts[0])) : null;
      const pull = repo?.pulls.get(Number(decoded?.parts[1]));
      if (repo === null || pull === undefined) throw new Error('pull request not found');
      if (pull.state !== 'open') throw new Error('pull request is not open');
      const commit = mergePullRecord(repo, pull);
      if (commit === null) throw new Error('pull request has conflicts');
      return completeValue(ctx, { type: 'MergePullRequestPayload', repo, pull } satisfies Typed, selection.selection);
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded?.kind !== 'issue') throw new Error('subject not found');
      const repo = repoByDbId(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === null || issue === undefined) throw new Error('subject not found');
      const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), seq: store.tick() };
      issue.comments.push(comment);
      const edge: Typed = { type: 'AddCommentEdge', repo, scalar: { type: 'IssueComment', repo, comment } };
      const payload: Typed = { type: 'AddCommentPayload', repo, scalar: edge };
      return completeValue(ctx, payload, selection.selection);
    }
    default:
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ----------------------------------------------------------------------------------------------
// The HTTP entry point.
// ----------------------------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(rawBody: unknown): GraphQLResult {
  if (Array.isArray(rawBody)) {
    const results = rawBody.map((entry) => executeOne(entry).body);
    return { status: 200, body: results };
  }
  const { status, body } = executeOne(rawBody);
  return { status, body };
}

function executeOne(rawBody: unknown): { status: number; body: unknown } {
  const body = rawBody !== null && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = body.variables !== null && typeof body.variables === 'object' ? (body.variables as Record<string, unknown>) : {};
  if (query === '') return { status: 400, body: { errors: [{ message: 'a query is required' }] } };
  let operations: OperationNode[];
  let fragments: Map<string, SelectionNode[]>;
  try {
    const parser = new Parser(query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { status: 200, body: { errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] } };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operations.find((candidate) => operationName === null || candidate.name === operationName) ?? operations[0];
  if (operation === undefined) return { status: 200, body: { errors: [{ message: 'no operation in the document' }] } };
  const { data, errors } = executeOperation(operation, variables, fragments);
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return { status: 200, body: out };
}
