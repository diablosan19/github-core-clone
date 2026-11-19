// mcp.ts — the MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks the 2026-07-28
// revision (server/discover, no handshake) and the legacy initialize handshake, and its six
// tools act on the same store as REST, git and GraphQL, so ids and numbers agree across
// surfaces. tools/list is a constant, so two calls answer byte-identically.

import { branchRef, store, type Repo } from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  createRepoRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
} from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: false, required };
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue on a repository.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

export interface McpResult {
  status: number;
  body: unknown;
  /** True when the request was a notification: answer 202 with no body. */
  empty?: boolean;
}

type Json = Record<string, unknown>;

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function toolResult(id: unknown, value: unknown): McpResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'string' ? { text: value } : value,
    isError: false,
  });
}

function toolFailure(id: unknown, message: string): McpResult {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

function repoFor(args: Json): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== '') store.adoptLogin(owner);
  if (owner !== store.viewerLogin()) return null;
  return store.repos.get(name) ?? null;
}

function callTool(id: unknown, name: string, args: Json): McpResult {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
  const required = (spec.inputSchema.required as string[] | undefined) ?? [];
  for (const property of required) {
    if (args[property] === undefined || args[property] === null || args[property] === '') {
      return rpcError(id, -32602, `missing required argument: ${property}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolResult(id, repoJson(existing));
      const repo = createRepoRecord(repoName, typeof args.description === 'string' ? args.description : '', args.private === true, 'main');
      return toolResult(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure(id, `repository ${String(args.owner)}/${String(args.repo)} was not found`);
      return toolResult(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure(id, 'repository was not found');
      const issue = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure(id, 'repository was not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return toolResult(id, issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure(id, 'repository was not found');
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(branchRef(head))) return toolFailure(id, `head branch ${head} does not exist`);
      if (!repo.refs.has(branchRef(base))) return toolFailure(id, `base branch ${base} does not exist`);
      const pull = createPullRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult(id, pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return toolFailure(id, 'repository was not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolFailure(id, `pull request ${String(args.pull_number)} was not found`);
      if (pull.state !== 'open') return toolFailure(id, 'pull request is not open');
      const commit = mergePullRecord(repo, pull);
      if (commit === null) return toolFailure(id, 'pull request has conflicts and could not be merged');
      return toolResult(id, { ...pullJson(repo, pull), sha: commit, merged: true });
    }
    default:
      return rpcError(id, -32602, `unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp body. A non-JSON body is a -32700 parse error at HTTP 400. */
export function handleMcp(rawText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleOne(entry)).filter((entry) => entry !== null);
    return { status: 200, body: results.map((entry) => entry!.body) };
  }
  const single = handleOne(parsed);
  if (single === null) return { status: 202, body: null, empty: true };
  return single;
}

function handleOne(entry: unknown): McpResult | null {
  if (entry === null || typeof entry !== 'object') return rpcError(null, -32600, 'Invalid request');
  const request = entry as Json;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Json) : {};
  if (id === undefined) {
    // A notification: accepted, never answered.
    return null;
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Json) : {};
      return callTool(id, name, args);
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
