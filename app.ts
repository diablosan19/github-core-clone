// app.ts — the HTTP server: routing and wire discipline for the four surfaces.
//
//   GET  /healthz                                  the boot probe
//   *    /api/v3/...                               REST v3 (rest.ts)
//   POST /api/graphql                              GraphQL v4 (graphql.ts)
//   POST /mcp                                      MCP (mcp.ts)
//   GET  /{owner}/{repo}.git/info/refs             git advertisement
//   POST /{owner}/{repo}.git/git-upload-pack       ls-refs / fetch
//   POST /{owner}/{repo}.git/git-receive-pack      push
//
// Auth is one bearer token (MAKEFUN_SHOP_TOKEN): a request without it is a 401 on every
// surface. REST answers are always JSON with an X-GitHub-Request-Id header; errors are JSON
// with a string message; unknown routes are JSON 404s, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { fetchV0, fetchV2, infoRefs, lsRefs, parseUploadBody, receivePack, receiveReport } from './git.ts';
import { store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 128 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null || body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expected}`;
}

function segmentsOf(req: IncomingMessage): { segments: string[]; query: URLSearchParams } {
  const url = new URL(req.url ?? '/', 'http://entry');
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { segments, query: url.searchParams };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[]): Promise<void> {
  const [owner, repoGit, ...rest] = segments as [string, string, ...string[]];
  const repoName = repoGit.endsWith('.git') ? repoGit.slice(0, -'.git'.length) : repoGit;
  store.adoptLogin(owner ?? '');
  const repo = owner !== undefined ? store.repoFor(owner, repoName) : null;
  if (repo === null) {
    sendBuffer(res, 404, 'text/plain', Buffer.from('repository not found'));
    return;
  }
  const tail = rest.join('/');
  if (req.method === 'GET' && tail === 'info/refs') {
    const query = new URL(req.url ?? '/', 'http://entry').searchParams;
    const service = query.get('service') ?? '';
    const protocolHeader = req.headers['git-protocol'];
    const version = typeof protocolHeader === 'string' && protocolHeader.includes('version=2') ? 2 : 0;
    const answer = infoRefs(repo, service, version);
    sendBuffer(res, answer.status, answer.contentType, answer.body);
    return;
  }
  if (req.method === 'POST' && tail === 'git-upload-pack') {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = parseUploadBody(body);
    } catch {
      sendBuffer(res, 400, 'text/plain', Buffer.from('malformed upload-pack request'));
      return;
    }
    if (parsed.version2 && parsed.command === 'ls-refs') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, parsed.args));
      return;
    }
    if (parsed.version2 && parsed.command === 'fetch') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV2(repo, parsed.fetch));
      return;
    }
    const sideband = parsed.capabilities.includes('side-band-64k');
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV0(repo, parsed.fetch, sideband));
    return;
  }
  if (req.method === 'POST' && tail === 'git-receive-pack') {
    const body = await readBody(req);
    const result = receivePack(repo, body);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', receiveReport(result));
    return;
  }
  sendBuffer(res, 404, 'text/plain', Buffer.from('not found'));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { segments, query } = segmentsOf(req);
  const method = req.method ?? 'GET';

  if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const isApi = segments[0] === 'api';
  const isMcp = segments.length === 1 && segments[0] === 'mcp';
  const isGit = segments.length >= 2 && segments[1]!.endsWith('.git');

  if ((isApi || isMcp || isGit) && !authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }

  if (isGit) {
    await handleGit(req, res, segments);
    return;
  }

  if (isMcp) {
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const result = handleMcp(raw);
    if (result.empty === true) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  if (isApi && segments[1] === 'v3') {
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const result = handleRest({
      method,
      segments: segments.slice(2),
      query,
      body,
      host: req.headers.host ?? '127.0.0.1',
    });
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  if (isApi && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'the body is not JSON' }] });
      return;
    }
    const result = handleGraphQL(body);
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // A handler failure must never take the server down: answer JSON and keep serving.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}
