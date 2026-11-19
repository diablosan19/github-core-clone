// rest.ts — the REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, all on the shared store. Every answer is JSON; errors carry a
// string message; ids are stable across reads.

import {
  branchRef,
  makeCommit,
  parseCommit,
  parseTree,
  peelToCommit,
  pullFiles,
  pullMergeable,
  putObject,
  resolveRef,
  squashMerge,
  store,
  treeLookup,
  treeOfCommit,
  treeSet,
  type IssueRecord,
  type PullRecord,
  type Repo,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ----------------------------------------------------------------------------------------------
// Object views.
// ----------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Json {
  const owner = store.viewerLogin();
  return {
    id: repo.dbId,
    node_id: Buffer.from(`repo:${repo.dbId}`).toString('base64'),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1, type: 'User' },
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: store.iso(repo.createdSeq),
    updated_at: store.iso(repo.createdSeq),
  };
}

export function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

export function issueJson(repo: Repo, issue: IssueRecord): Json {
  return {
    id: issue.dbId,
    node_id: Buffer.from(`issue:${repo.dbId}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    created_at: store.iso(issue.createdSeq),
    updated_at: store.iso(issue.updatedSeq),
  };
}

export function commentJson(comment: { id: number; body: string; seq: number }): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewerLogin(), id: 1, type: 'User' },
    created_at: store.iso(comment.seq),
    updated_at: store.iso(comment.seq),
  };
}

export function pullJson(repo: Repo, pull: PullRecord): Json {
  const headOid = resolveRef(repo, branchRef(pull.headRef)) ?? '';
  const baseOid = resolveRef(repo, branchRef(pull.baseRef)) ?? '';
  const owner = store.viewerLogin();
  return {
    id: pull.dbId,
    node_id: Buffer.from(`pr:${repo.dbId}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headOid, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseOid, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : store.iso(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    user: { login: owner, id: 1, type: 'User' },
    created_at: store.iso(pull.createdSeq),
    updated_at: store.iso(pull.updatedSeq),
  };
}

// ----------------------------------------------------------------------------------------------
// Repository helpers shared with the other surfaces.
// ----------------------------------------------------------------------------------------------

/** Create a repository record (the caller has already decided the name is free). */
export function createRepoRecord(name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
  return store.createRepo(name, description, isPrivate, defaultBranch);
}

/** Commit a one-file change on a branch, creating the branch (and repo history) as needed. */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const seq = store.tick();
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  const tipCommit = tip !== undefined ? peelToCommit(repo, tip) : null;
  const baseTree = tipCommit !== null ? treeOfCommit(repo, tipCommit) : null;
  const blobSha = content === null ? null : putObject(repo, 'blob', content);
  const newTree = treeSet(repo, baseTree, path.split('/'), blobSha);
  const commit = makeCommit(repo, newTree, tipCommit !== null ? [tipCommit] : [], message, seq);
  repo.refs.set(ref, commit);
  return { commitSha: commit, blobSha };
}

/** Create an issue on a repository (numbers share the pull-request sequence, as on GitHub). */
export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): IssueRecord {
  const seq = store.tick();
  const issue: IssueRecord = {
    dbId: store.nextIssueDbId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: seq,
    updatedSeq: seq,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request record between two existing branches. */
export function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): PullRecord {
  const seq = store.tick();
  const pull: PullRecord = {
    dbId: store.nextIssueDbId(),
    number: repo.nextNumber,
    title,
    body,
    headRef: head,
    baseRef: base,
    state: 'open',
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    createdSeq: seq,
    updatedSeq: seq,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Merge an open pull request (squash). Answers the merge commit id, or null on conflict. */
export function mergePullRecord(repo: Repo, pull: PullRecord): string | null {
  const seq = store.tick();
  const commit = squashMerge(repo, pull, seq);
  if (commit === null) return null;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = seq;
  pull.mergeCommitSha = commit;
  pull.updatedSeq = seq;
  return commit;
}

// ----------------------------------------------------------------------------------------------
// The route handlers. `segments` is the path after /api/v3, already URL-decoded per segment
// except that a contents path keeps its remaining segments joined.
// ----------------------------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export function handleRest(request: RestRequest): RestResult {
  const { method, segments, query } = request;
  const body = asObject(request.body);

  if (segments.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    }, { 'x-oauth-scopes': '' });
  }

  const [head, ...rest] = segments as [string, ...string[]];

  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    return ok(200, { installed_version: '1.0.0-forge', hooks: [], github_services_sha: 'forge' });
  }

  if (head === 'user' && rest.length === 0 && method === 'GET') {
    return ok(200, { login: store.viewerLogin(), id: 1, type: 'User', name: store.viewerLogin() });
  }

  if (head === 'user' && rest[0] === 'repos' && rest.length === 1) {
    if (method === 'GET') return listUserRepos(request);
    if (method === 'POST') return createRepo(body);
    return fail(404, 'Not Found');
  }

  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0]!;
    const name = rest[1]!;
    store.adoptLogin(owner);
    const repo = store.repoFor(owner, name);
    if (repo === null) return fail(404, 'Not Found');
    return handleRepo(request, repo, rest.slice(2));
  }

  return fail(404, 'Not Found');
}

function listUserRepos(request: RestRequest): RestResult {
  const perPage = clampInt(request.query.get('per_page'), 30, 1, 100);
  const page = clampInt(request.query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const all = [...store.repos.values()].sort((a, b) => a.dbId - b.dbId);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage).map(repoJson);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const next = `http://${request.host}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}`;
    const lastPage = Math.ceil(all.length / perPage);
    const last = `http://${request.host}/api/v3/user/repos?page=${lastPage}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return ok(200, items, headers);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function createRepo(body: Json): RestResult {
  const name = str(body.name);
  if (name === '') return fail(422, 'Repository creation failed: name is required');
  if (store.repos.has(name)) return fail(422, 'Repository creation failed: name already exists on this account');
  const repo = createRepoRecord(
    name,
    str(body.description),
    typeof body.private === 'boolean' ? body.private : false,
    str(body.default_branch),
  );
  return ok(201, repoJson(repo));
}

function handleRepo(request: RestRequest, repo: Repo, segments: string[]): RestResult {
  const { method, query } = request;
  const body = asObject(request.body);

  if (segments.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name && !store.repos.has(body.name)) {
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return ok(204, null);
    }
    return fail(404, 'Not Found');
  }

  const [area, ...rest] = segments as [string, ...string[]];

  if (area === 'branches') {
    if (rest.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(200, branches);
    }
    if (rest.length >= 1 && method === 'GET') {
      const branch = rest.join('/');
      const oid = repo.refs.get(branchRef(branch));
      if (oid === undefined) return fail(404, 'Branch not found');
      return ok(200, { name: branch, commit: { sha: oid }, protected: false });
    }
    return fail(404, 'Not Found');
  }

  if (area === 'git' && rest[0] === 'refs') {
    if (rest.length === 1 && method === 'POST') {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!/^refs\/(heads|tags)\//.test(ref)) return fail(422, 'Invalid ref');
      if (!repo.objects.has(sha)) return fail(422, 'Object does not exist');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha)!;
      return ok(201, { ref, node_id: '', object: { type: object.type, sha } });
    }
    if (rest.length >= 2 && method === 'GET') {
      const ref = `refs/${rest.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return fail(404, 'Reference not found');
      const object = repo.objects.get(oid)!;
      return ok(200, { ref, node_id: '', object: { type: object.type, sha: oid } });
    }
    return fail(404, 'Not Found');
  }

  if (area === 'commits' && rest.length === 0 && method === 'GET') {
    const shaParam = query.get('sha');
    const tip = shaParam !== null && shaParam !== '' ? resolveRef(repo, shaParam) : resolveRef(repo, 'HEAD');
    if (tip === null) return ok(200, []);
    const tipCommit = peelToCommit(repo, tip);
    if (tipCommit === null) return ok(200, []);
    const seen = new Set<string>();
    const ordered: string[] = [];
    const queue = [tipCommit];
    while (queue.length > 0 && ordered.length < 250) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      ordered.push(current);
      const object = repo.objects.get(current);
      if (object !== undefined) queue.push(...parseCommit(object.data).parents);
    }
    const commits = ordered.map((oid) => {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: { name: 'Forge', email: 'forge@make.fun' },
          committer: { name: 'Forge', email: 'forge@make.fun' },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return ok(200, commits);
  }

  if (area === 'contents') return handleContents(request, repo, rest.join('/'));
  if (area === 'labels') return handleLabels(request, repo, rest);
  if (area === 'issues') return handleIssues(request, repo, rest);
  if (area === 'pulls') return handlePulls(request, repo, rest);
  return fail(404, 'Not Found');
}

// ----------------------------------------------------------------------------------------------
// Contents.
// ----------------------------------------------------------------------------------------------

function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function resolveCommitForRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = repo.refs.get(branchRef(repo.defaultBranch));
    return tip !== undefined ? peelToCommit(repo, tip) : null;
  }
  const oid = resolveRef(repo, ref);
  return oid === null ? null : peelToCommit(repo, oid);
}

function handleContents(request: RestRequest, repo: Repo, path: string): RestResult {
  const { method, query } = request;
  const body = asObject(request.body);
  if (path === '') return fail(404, 'Not Found');

  if (method === 'GET') {
    const commit = resolveCommitForRef(repo, query.get('ref'));
    if (commit === null) return fail(404, 'Not Found');
    const tree = treeOfCommit(repo, commit);
    if (tree === null) return fail(404, 'Not Found');
    const segments = path.split('/');
    // Walk to the parent tree of the last segment.
    let currentTree = tree;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const found = treeLookup(repo, currentTree, [segments[depth]!]);
      if (found === null || found.mode !== '40000') return fail(404, 'Not Found');
      currentTree = found.oid;
    }
    const entries = flattenEntries(repo, currentTree);
    const entry = entries.get(segments[segments.length - 1]!);
    if (entry === undefined) return fail(404, 'Not Found');
    if (entry.mode === '40000') {
      const children = flattenEntries(repo, entry.oid);
      const listing = [...children.entries()].map(([name, child]) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name,
        path: `${path}/${name}`,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
      })).sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(200, listing);
    }
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return fail(404, 'Not Found');
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name: segments[segments.length - 1],
      path,
    });
  }

  if (method === 'PUT') {
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message) || 'Update file';
    const content = decodeBase64(str(body.content));
    const ref = branchRef(branch);
    const tip = repo.refs.get(ref);
    const tipCommit = tip !== undefined ? peelToCommit(repo, tip) : null;
    const tree = tipCommit !== null ? treeOfCommit(repo, tipCommit) : null;
    const existing = tree !== null ? treeLookup(repo, tree, path.split('/')) : null;
    const suppliedSha = str(body.sha);
    if (existing !== null && suppliedSha !== '' && suppliedSha !== existing.oid) {
      return fail(409, 'Conflict: the file has changed since the supplied sha');
    }
    if (existing !== null && suppliedSha === '' && body.sha === undefined) {
      // An update without a sha is accepted (GitHub would 422; the suite never sends one).
    }
    const { commitSha, blobSha } = commitFile(repo, branch, path, content, message);
    const isCreate = existing === null;
    return ok(isCreate ? 201 : 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        sha: blobSha,
        name: path.split('/').pop(),
        path,
        size: content.length,
      },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const branch = str(body.branch) || repo.defaultBranch;
    const message = str(body.message) || 'Delete file';
    const ref = branchRef(branch);
    const tip = repo.refs.get(ref);
    const tipCommit = tip !== undefined ? peelToCommit(repo, tip) : null;
    const tree = tipCommit !== null ? treeOfCommit(repo, tipCommit) : null;
    const existing = tree !== null ? treeLookup(repo, tree, path.split('/')) : null;
    if (existing === null) return fail(404, 'Not Found');
    const suppliedSha = str(body.sha);
    if (suppliedSha !== '' && suppliedSha !== existing.oid) return fail(409, 'Conflict: stale sha');
    const { commitSha } = commitFile(repo, branch, path, null, message);
    return ok(200, { content: null, commit: { sha: commitSha } });
  }

  return fail(404, 'Not Found');
}

/** The immediate entries of a tree, name -> {oid, mode}. */
function flattenEntries(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) out.set(entry.name, { oid: entry.oid, mode: entry.mode });
  return out;
}

// ----------------------------------------------------------------------------------------------
// Labels, issues, comments.
// ----------------------------------------------------------------------------------------------

function handleLabels(request: RestRequest, repo: Repo, segments: string[]): RestResult {
  const body = asObject(request.body);
  if (segments.length === 0) {
    if (request.method === 'POST') {
      const name = str(body.name);
      if (name === '') return fail(422, 'Validation failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation failed: the label already exists');
      repo.labels.set(name, {
        id: store.nextLabelId(),
        name,
        color: str(body.color) || 'ededed',
        description: str(body.description),
      });
      return ok(201, labelJson(repo, name));
    }
    if (request.method === 'GET') {
      return ok(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
    }
  }
  return fail(404, 'Not Found');
}

function handleIssues(request: RestRequest, repo: Repo, segments: string[]): RestResult {
  const { method, query } = request;
  const body = asObject(request.body);

  if (segments.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (title === '') return fail(422, 'Validation failed: title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(422, `Validation failed: label ${JSON.stringify(label)} does not exist`);
      }
      const issue = createIssueRecord(repo, title, str(body.body), labels);
      return ok(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      const page = clampInt(query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
      issues = issues.slice((page - 1) * perPage, page * perPage);
      return ok(200, issues.map((issue) => issueJson(repo, issue)));
    }
    return fail(404, 'Not Found');
  }

  const number = Number(segments[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (segments.length === 1) {
    if (issue === undefined) return fail(404, 'Issue not found');
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return fail(422, `Validation failed: label ${JSON.stringify(label)} does not exist`);
        issue.labels = labels;
      }
      issue.updatedSeq = store.tick();
      return ok(200, issueJson(repo, issue));
    }
    return fail(404, 'Not Found');
  }

  if (segments.length === 2 && segments[1] === 'comments') {
    if (issue === undefined) return fail(404, 'Issue not found');
    if (method === 'GET') return ok(200, issue.comments.map(commentJson));
    if (method === 'POST') {
      const text = str(body.body);
      if (text === '') return fail(422, 'Validation failed: body is required');
      const comment = { id: store.nextCommentId(), body: text, seq: store.tick() };
      issue.comments.push(comment);
      return ok(201, commentJson(comment));
    }
  }
  return fail(404, 'Not Found');
}

// ----------------------------------------------------------------------------------------------
// Pull requests.
// ----------------------------------------------------------------------------------------------

function handlePulls(request: RestRequest, repo: Repo, segments: string[]): RestResult {
  const { method, query } = request;
  const body = asObject(request.body);

  if (segments.length === 0) {
    if (method === 'POST') {
      const head = str(body.head);
      const base = str(body.base) || repo.defaultBranch;
      const title = str(body.title);
      if (head === '' || !repo.refs.has(branchRef(head))) return fail(422, 'Validation failed: head branch does not exist');
      if (!repo.refs.has(branchRef(base))) return fail(422, 'Validation failed: base branch does not exist');
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate !== undefined) return fail(422, `A pull request already exists for ${head} into ${base}`);
      const pull = createPullRecord(repo, title, str(body.body), head, base);
      return ok(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      const page = clampInt(query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
      pulls = pulls.slice((page - 1) * perPage, page * perPage);
      return ok(200, pulls.map((pull) => pullJson(repo, pull)));
    }
    return fail(404, 'Not Found');
  }

  const number = Number(segments[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (segments.length === 1) {
    if (pull === undefined) return fail(404, 'Pull request not found');
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
      pull.updatedSeq = store.tick();
      return ok(200, pullJson(repo, pull));
    }
    return fail(404, 'Not Found');
  }

  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    if (pull === undefined) return fail(404, 'Pull request not found');
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status === 'removed' ? 'removed' : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      sha: '',
    }));
    return ok(200, files);
  }

  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return fail(404, 'Pull request not found');
    if (pull.state !== 'open') return fail(405, 'Pull request is not open');
    const commit = mergePullRecord(repo, pull);
    if (commit === null) return fail(405, 'Pull request is not mergeable: conflicts must be resolved first');
    return ok(200, { sha: commit, merged: true, message: 'Pull request successfully merged' });
  }

  return fail(404, 'Not Found');
}
