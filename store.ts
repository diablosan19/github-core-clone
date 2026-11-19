// store.ts — the forge's single in-memory state and its git object model.
//
// Every surface (git smart HTTP, REST v3, GraphQL v4, MCP) reads and writes this one store, so
// an object created on one surface is the same object on all the others. Nothing here touches
// the wall clock or a random source: timestamps come from a logical clock (a fixed base epoch
// plus a per-event counter), so an identical sequence of requests produces byte-identical
// objects, commits included.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
const BASE_EPOCH = 1_700_000_000;
const FORGE_IDENT = 'Forge <forge@make.fun>';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRecord {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  createdSeq: number;
  updatedSeq: number;
}

export interface PullRecord {
  dbId: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  dbId: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  nextNumber: number;
  createdSeq: number;
}

export class Store {
  /** The login the bearer token names; adopted from the first owner-scoped path the suite uses. */
  login: string | null = null;
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  private clock = 0;

  /** The next logical timestamp (seconds since the base epoch). */
  tick(): number {
    this.clock += 1;
    return BASE_EPOCH + this.clock;
  }

  /** An ISO timestamp for a logical sequence value. */
  iso(seq: number): string {
    return new Date(seq * 1000).toISOString();
  }

  /** Learn the token owner's login the first time an owner-scoped path names one. */
  adoptLogin(owner: string): string {
    if (this.login === null && owner !== '') this.login = owner;
    return this.login ?? owner;
  }

  viewerLogin(): string {
    return this.login ?? 'viewer';
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      dbId: this.repoSeq,
      name,
      description,
      isPrivate,
      defaultBranch: defaultBranch === '' ? 'main' : defaultBranch,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.tick(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Resolve a repository for an owner path segment: another owner's namespace is a 404. */
  repoFor(owner: string, name: string): Repo | null {
    this.adoptLogin(owner);
    if (owner !== this.viewerLogin()) return null;
    return this.repos.get(name) ?? null;
  }

  nextIssueDbId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }
}

/** The one process-wide store. */
export const store = new Store();

// ----------------------------------------------------------------------------------------------
// Git object primitives.
// ----------------------------------------------------------------------------------------------

/** The SHA-1 object id of a typed payload: sha1("<type> <len>\0" + bytes). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in a repository (idempotent) and answer its id. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object into its header parts and message. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parts: CommitParts = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) parts.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parts.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) parts.author = line.slice(7);
    else if (line.startsWith('committer ')) parts.committer = line.slice(10);
  }
  return parts;
}

/** Serialize a commit with the forge identity and a logical timestamp. */
export function buildCommit(tree: string, parents: string[], message: string, seq: number): Buffer {
  const ident = `${FORGE_IDENT} ${seq} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Create and store a commit; answers its object id. */
export function makeCommit(repo: Repo, tree: string, parents: string[], message: string, seq: number): string {
  return putObject(repo, 'commit', buildCommit(tree, parents, message, seq));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object (binary entries: "<mode> <name>\0<20-byte oid>"). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', at, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Serialize tree entries, sorted the way git sorts them (directories as name + "/"). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Peel a tag (or any object) down to the commit it ultimately names, or null. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

/** Read a blob's bytes by walking a tree path; null when any step misses. */
export function treeLookup(repo: Repo, treeOid: string, segments: string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Set (or, with blobOid null, remove) the blob at a path inside a tree, rebuilding the tree
 * chain. Answers the new root tree id; an empty result tree answers the empty tree's id.
 */
export function treeSet(repo: Repo, treeOid: string | null, segments: string[], blobOid: string | null): string {
  const entries: TreeEntry[] = treeOid === null ? [] : (repo.objects.get(treeOid)?.type === 'tree' ? parseTree(repo.objects.get(treeOid)!.data) : []);
  const [head, ...rest] = segments as [string, ...string[]];
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const child = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = treeSet(repo, child?.oid ?? null, rest, blobOid);
    const childObject = repo.objects.get(childOid);
    const childEmpty = childObject !== undefined && childObject.type === 'tree' && childObject.data.length === 0;
    if (!childEmpty) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return putObject(repo, 'tree', buildTree(kept));
}

/** Flatten a tree into a path -> entry map (files only carry blobs; dirs recurse). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(repo, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Every commit reachable from a tip (inclusive), newest first by logical construction order. */
export function ancestorsOf(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  return ancestorsOf(repo, tip).has(ancestor);
}

/** A common ancestor of two commits (breadth-first from both), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestorsOf(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (fromA.has(current)) return current;
    const object = repo.objects.get(current);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Count the lines of a text payload the way a diff summary does (a trailing line counts). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** The ref a branch name lives at. */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Resolve a ref name, branch name, or HEAD to an object id, or null. */
export function resolveRef(repo: Repo, name: string): string | null {
  if (name === 'HEAD') {
    const tip = repo.refs.get(branchRef(repo.defaultBranch));
    return tip ?? null;
  }
  const direct = repo.refs.get(name);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(branchRef(name));
  if (asBranch !== undefined) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${name}`);
  if (asTag !== undefined) return asTag;
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return name;
  return null;
}

// ----------------------------------------------------------------------------------------------
// Pull request diffs and three-way merges, shared by REST and GraphQL.
// ----------------------------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** The file-level diff between two commits' trees (merge-base aware when a base is given). */
export function diffTrees(repo: Repo, fromTree: string, toTree: string): ChangedFile[] {
  const from = flattenTree(repo, fromTree);
  const to = flattenTree(repo, toTree);
  const files: ChangedFile[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeLines = before === undefined ? 0 : countLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0));
    const afterLines = after === undefined ? 0 : countLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0));
    files.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: afterLines,
      deletions: beforeLines,
    });
  }
  return files;
}

/** The changed files of a pull request: its head tree against the merge-base tree. */
export function pullFiles(repo: Repo, pull: PullRecord): ChangedFile[] {
  const headOid = resolveRef(repo, branchRef(pull.headRef));
  const baseOid = resolveRef(repo, branchRef(pull.baseRef));
  if (headOid === null || baseOid === null) return [];
  const headCommit = peelToCommit(repo, headOid);
  const baseCommit = peelToCommit(repo, baseOid);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const fromTree = treeOfCommit(repo, base);
  const toTree = treeOfCommit(repo, headCommit);
  if (fromTree === null || toTree === null) return [];
  return diffTrees(repo, fromTree, toTree);
}

/**
 * A three-way tree merge of head into base at their merge-base. Answers the merged tree id, or
 * null when a path changed on both sides in incompatible ways (a conflict).
 */
export function mergeTrees(repo: Repo, baseCommit: string, headCommit: string): string | null {
  const base = mergeBase(repo, baseCommit, headCommit);
  if (base === null) return null;
  const ancestorTree = treeOfCommit(repo, base);
  const baseTree = treeOfCommit(repo, baseCommit);
  const headTree = treeOfCommit(repo, headCommit);
  if (ancestorTree === null || baseTree === null || headTree === null) return null;
  const ancestor = flattenTree(repo, ancestorTree);
  const ours = flattenTree(repo, baseTree);
  const theirs = flattenTree(repo, headTree);
  const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  let mergedTree: string | null = null;
  const apply = (path: string, oid: string | null): void => {
    mergedTree = treeSet(repo, mergedTree, path.split('/'), oid);
  };
  // Start from the base (ours) tree and apply the paths where theirs moved.
  mergedTree = baseTree;
  for (const path of paths) {
    const a = ancestor.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (t === a) continue; // head did not move this path; ours stands
    if (o === a) {
      apply(path, t); // only head moved it
      continue;
    }
    if (o === t) continue; // both moved it the same way
    return null; // both moved it differently: a conflict
  }
  return mergedTree;
}

/**
 * Squash-merge an open pull request: one new commit on the base branch holding the merged
 * tree. Answers the merge commit id, or null on conflict.
 */
export function squashMerge(repo: Repo, pull: PullRecord, seq: number): string | null {
  const headOid = resolveRef(repo, branchRef(pull.headRef));
  const baseOid = resolveRef(repo, branchRef(pull.baseRef));
  if (headOid === null || baseOid === null) return null;
  const headCommit = peelToCommit(repo, headOid);
  const baseCommit = peelToCommit(repo, baseOid);
  if (headCommit === null || baseCommit === null) return null;
  const mergedTree = mergeTrees(repo, baseCommit, headCommit);
  if (mergedTree === null) return null;
  const message = `${pull.title}\n\nSquash-merged from ${pull.headRef} (#${pull.number}).`;
  const commit = makeCommit(repo, mergedTree, [baseCommit], message, seq);
  repo.refs.set(branchRef(pull.baseRef), commit);
  return commit;
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: PullRecord): boolean {
  if (pull.state !== 'open') return false;
  const headOid = resolveRef(repo, branchRef(pull.headRef));
  const baseOid = resolveRef(repo, branchRef(pull.baseRef));
  if (headOid === null || baseOid === null) return false;
  const headCommit = peelToCommit(repo, headOid);
  const baseCommit = peelToCommit(repo, baseOid);
  if (headCommit === null || baseCommit === null) return false;
  return mergeTrees(repo, baseCommit, headCommit) !== null;
}
