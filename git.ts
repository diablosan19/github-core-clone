// git.ts — the git smart-HTTP protocol: advertisement, ls-refs, fetch (v2 and v0, with shallow
// and deepen), and receive-pack with report-status. Packs are read with delta resolution
// (OFS_DELTA and REF_DELTA) and written delta-free. Everything runs on the shared store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  ancestorsOf,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  treeOfCommit,
  type ObjectType,
  type Repo,
} from './store.ts';

const AGENT = 'forge/1.0';
const TYPE_BY_CODE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const CODE_BY_TYPE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

// ----------------------------------------------------------------------------------------------
// pkt-line framing.
// ----------------------------------------------------------------------------------------------

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** A side-band pkt-line: band byte + payload inside one pkt frame. */
export function pktBand(band: number, payload: Buffer): Buffer {
  return pkt(Buffer.concat([Buffer.from([band]), payload]));
}

export interface PktLine {
  /** The payload, or null for a flush packet, or 'delim' for a delimiter packet. */
  payload: Buffer | null | 'delim';
  next: number;
}

/** Read one pkt-line at `at`; throws on a malformed frame. */
export function readPkt(buf: Buffer, at: number): PktLine {
  if (at + 4 > buf.length) throw new Error('truncated pkt-line');
  const hex = buf.toString('ascii', at, at + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
  const length = parseInt(hex, 16);
  if (length === 0) return { payload: null, next: at + 4 };
  if (length === 1) return { payload: 'delim', next: at + 4 };
  if (length === 2) return { payload: Buffer.alloc(0), next: at + 4 }; // response-end: treat as empty
  if (length < 4 || at + length > buf.length) throw new Error('pkt-line overruns the body');
  return { payload: buf.subarray(at + 4, at + length), next: at + length };
}

// ----------------------------------------------------------------------------------------------
// Pack reading and writing.
// ----------------------------------------------------------------------------------------------

/**
 * Inflate the first zlib stream in `buf`, answering its data and exact consumed length.
 * inflateSync ignores trailing bytes and throws on a truncated stream, so the consumed length
 * is the smallest prefix that inflates — found by an exponential probe plus a binary search.
 */
export function inflateFirst(buf: Buffer): { data: Buffer; consumed: number } {
  const ok = (n: number): boolean => {
    try {
      inflateSync(buf.subarray(0, n));
      return true;
    } catch {
      return false;
    }
  };
  let lo = 1;
  let hi = Math.min(buf.length, 256);
  while (hi < buf.length && !ok(hi)) {
    lo = hi + 1;
    hi = Math.min(buf.length, hi * 2);
  }
  if (!ok(hi)) throw new Error('corrupt zlib stream in pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(buf.subarray(0, lo)), consumed: lo };
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at]!;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at]!;
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if ((op & (1 << bit)) !== 0) { offset |= delta[at]! << (8 * bit); at += 1; }
      for (let bit = 0; bit < 3; bit += 1) if ((op & (0x10 << bit)) !== 0) { size |= delta[at]! << (8 * bit); at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackObject {
  type: ObjectType;
  data: Buffer;
  /** The pack offset where this object's header starts (OFS_DELTA bases point back to it). */
  offset: number;
}

/**
 * Parse a packfile into resolved objects. Deltas are resolved against bases inside the pack or
 * already in the repository. Throws on any structural problem; nothing is stored on failure.
 */
export function parsePack(repo: Repo, pack: Buffer): PackObject[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  let at = 12;
  const raw: { typeCode: number; data: Buffer; offset: number; baseRef?: string; baseOffset?: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at]!;
    at += 1;
    const typeCode = (byte >> 4) & 0x7;
    // The size is informational here; the zlib stream delimits the object on its own.
    while ((byte & 0x80) !== 0) { byte = pack[at]!; at += 1; }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base object's header.
      let back = pack[at]!;
      at += 1;
      let offset = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = pack[at]!;
        at += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      const { data, consumed } = inflateFirst(pack.subarray(at));
      at += consumed;
      raw.push({ typeCode, data, offset: start, baseOffset: start - offset });
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id, 20 raw bytes.
      const baseRef = pack.toString('hex', at, at + 20);
      at += 20;
      const { data, consumed } = inflateFirst(pack.subarray(at));
      at += consumed;
      raw.push({ typeCode, data, offset: start, baseRef });
    } else {
      const type = TYPE_BY_CODE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflateFirst(pack.subarray(at));
      at += consumed;
      raw.push({ typeCode, data, offset: start });
    }
  }
  const byOffset = new Map<number, PackObject>();
  const resolved = new Map<number, PackObject>();
  const resolveAt = (index: number): PackObject => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    const entry = raw[index]!;
    let object: PackObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: PackObject | undefined;
      if (entry.typeCode === 6) {
        const baseIndex = raw.findIndex((candidate) => candidate.offset === entry.baseOffset);
        if (baseIndex === -1) throw new Error('OFS_DELTA base is not in the pack');
        base = resolveAt(baseIndex);
      } else {
        const inPack = raw.findIndex((candidate, candidateIndex) => {
          if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
          return hashObject(TYPE_BY_CODE[candidate.typeCode]!, candidate.data) === entry.baseRef;
        });
        if (inPack !== -1) base = resolveAt(inPack);
        else {
          const stored = repo.objects.get(entry.baseRef!);
          if (stored === undefined) throw new Error('REF_DELTA base is unknown');
          base = { type: stored.type, data: stored.data, offset: -1 };
        }
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data), offset: entry.offset };
    } else {
      object = { type: TYPE_BY_CODE[entry.typeCode]!, data: entry.data, offset: entry.offset };
    }
    resolved.set(index, object);
    byOffset.set(entry.offset, object);
    return object;
  };
  const objects: PackObject[] = [];
  for (let index = 0; index < raw.length; index += 1) objects.push(resolveAt(index));
  return objects;
}

/** Serialize objects into a delta-free packfile with a SHA-1 trailer. */
export function buildPack(objects: { type: ObjectType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (CODE_BY_TYPE[object.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ----------------------------------------------------------------------------------------------
// Reference advertisement.
// ----------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref lines (without the service preamble), HEAD first, tags peeled. */
function advertisementLines(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    return [pkt(`${ZERO_OID} capabilities^{}\0${caps}`)];
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  const lines: Buffer[] = [pkt(`${headOid} HEAD\0${caps}`)];
  for (const [name, oid] of refs) {
    lines.push(pkt(`${oid} ${name}`));
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const commit = peelToCommit(repo, oid);
      if (commit !== null) lines.push(pkt(`${commit} ${name}^{}`));
    }
  }
  return lines;
}

/** GET /{owner}/{repo}.git/info/refs — v0 with a service preamble, or the v2 capability list. */
export function infoRefs(repo: Repo, service: string, protocolVersion: number): { status: number; contentType: string; body: Buffer } {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (protocolVersion === 2 && service === 'git-upload-pack') {
    const lines = [
      pkt('version 2'),
      pkt(`agent=${AGENT}`),
      pkt('ls-refs=unborn'),
      pkt('fetch=shallow'),
      pkt('object-format=sha1'),
      FLUSH,
    ];
    return { status: 200, contentType, body: Buffer.concat(lines) };
  }
  const parts = [pkt(`# service=${service}`), FLUSH, ...advertisementLines(repo, service), FLUSH];
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ----------------------------------------------------------------------------------------------
// ls-refs (protocol v2).
// ----------------------------------------------------------------------------------------------

export function lsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}`));
    } else if (unborn) {
      lines.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}`));
    } else {
      lines.push(pkt(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${target}` : ''}`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const commit = peelToCommit(repo, oid);
        if (commit !== null) line += ` peeled:${commit}`;
      }
    }
    lines.push(pkt(line));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ----------------------------------------------------------------------------------------------
// Fetch: closure computation, shallow handling, pack assembly.
// ----------------------------------------------------------------------------------------------

/** The full tree/blob closure of one tree (the tree itself included). */
function treeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) queue.push(entry.oid);
  }
}

/**
 * The commits a client holds when it has the given haves: every ancestor of the haves, but
 * the walk does not descend past a shallow-boundary commit (the client holds the boundary
 * commit and its trees, not its parents).
 */
function heldCommits(repo: Repo, haves: Set<string>, boundary: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    held.add(oid);
    if (boundary.has(oid)) continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return held;
}

/** The object set belonging to a set of commits: the commits plus their tree closures. */
function objectsOfCommits(repo: Repo, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.add(oid);
    treeClosure(repo, parseCommit(object.data).tree, out);
  }
  return out;
}

/** Ancestors of the wants, optionally stopping the descent at shallow-boundary commits. */
function includedAncestors(repo: Repo, wants: Set<string>, boundary: Set<string>): Set<string> {
  const included = new Set<string>();
  const queue = [...wants];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.add(oid);
    if (boundary.has(oid)) continue;
    queue.push(...parseCommit(object.data).parents);
  }
  return included;
}

/** Commits grouped by generation distance from the wants (want = generation 1), BFS order. */
function generations(repo: Repo, wants: string[]): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [...new Set(wants)];
  let level = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (depth.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      depth.set(oid, level);
      next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
    level += 1;
  }
  return depth;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Compute the object set a fetch sends, plus the shallow lines the answer must carry. */
export function planFetch(repo: Repo, request: FetchRequest): { send: string[]; shallowLines: string[] } {
  const wantCommits = new Set<string>();
  for (const want of request.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null) wantCommits.add(commit);
  }
  const haveCommits = new Set<string>();
  for (const have of request.haves) {
    const commit = peelToCommit(repo, have);
    if (commit !== null) haveCommits.add(commit);
  }
  const boundary = new Set<string>();
  for (const entry of request.shallow) {
    const commit = peelToCommit(repo, entry);
    if (commit !== null) boundary.add(commit);
  }
  const held = heldCommits(repo, haveCommits, boundary);
  const heldObjects = objectsOfCommits(repo, held);
  const shallowLines: string[] = [];
  let included: Set<string>;

  if (request.deepen !== null || request.deepenSince !== null) {
    // A depth-limited fetch: history is cut at a depth measured from the wants alone (the
    // want is generation 1). A deepen of an existing shallow clone names the same tip as
    // want and have, so the deeper generations simply join the included set; the boundary
    // moves down, it does not expand sideways below the old boundary.
    const depthLimit = request.deepen ?? Number.MAX_SAFE_INTEGER;
    included = new Set<string>();
    for (const [oid, level] of generations(repo, [...wantCommits])) {
      if (level <= depthLimit) included.add(oid);
    }
    if (request.deepenSince !== null) {
      for (const oid of [...included]) {
        const object = repo.objects.get(oid);
        if (object === undefined) continue;
        const match = / (\d+) [+-]\d{4}/.exec(parseCommit(object.data).committer);
        if (match !== null && Number(match[1]) < request.deepenSince) included.delete(oid);
      }
    }
    // Boundary bookkeeping: included commits whose parents stayed out are the new boundary;
    // old boundary commits whose parents all came in are unshallowed.
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => repo.objects.has(parent) && !included.has(parent))) shallowLines.push(`shallow ${oid}`);
    }
    for (const old of boundary) {
      const object = repo.objects.get(old);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => included.has(parent))) shallowLines.push(`unshallow ${old}`);
    }
  } else if (boundary.size > 0) {
    // A plain fetch from a shallow client: the boundary stays where it was.
    included = includedAncestors(repo, wantCommits, boundary);
    for (const commit of boundary) shallowLines.push(`shallow ${commit}`);
  } else {
    included = includedAncestors(repo, wantCommits, new Set());
  }

  const sendCommits = [...included].filter((oid) => !held.has(oid));
  const sendSet = objectsOfCommits(repo, sendCommits);
  // Wanted tag objects ride along when their commit is in the sent or held history.
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') {
      const commit = peelToCommit(repo, want);
      if (commit !== null && included.has(commit)) sendSet.add(want);
    }
  }
  for (const oid of heldObjects) sendSet.delete(oid);
  return { send: [...sendSet], shallowLines };
}

/** Build the pack bytes for a set of object ids. */
export function packFor(repo: Repo, oids: string[]): Buffer {
  const objects: { type: ObjectType; data: Buffer }[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return buildPack(objects);
}

/** Frame pack bytes as side-band-64k packets (band 1), optionally with a final flush. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pktBand(1, pack.subarray(at, Math.min(pack.length, at + CHUNK))));
  }
  return parts;
}

/** The fetch v2 answer: acknowledgments, shallow-info, then the packfile section. */
export function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const { send, shallowLines } = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    const acked = request.haves.find((have) => repo.objects.get(have)?.type === 'commit');
    parts.push(pkt('acknowledgments\n'));
    parts.push(pkt(acked !== undefined ? `ACK ${acked}` : 'NAK'));
    parts.push(DELIM);
  }
  if (shallowLines.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const line of shallowLines) parts.push(pkt(line));
    parts.push(DELIM);
  }
  if (send.length > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(packFor(repo, send)));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The fetch v0 answer: shallow lines, NAK, then the side-band pack. */
export function fetchV0(repo: Repo, request: FetchRequest, sideband: boolean): Buffer {
  const { send, shallowLines } = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const line of shallowLines) parts.push(pkt(`${line}\n`));
  parts.push(pkt('NAK\n'));
  if (send.length > 0) {
    const pack = packFor(repo, send);
    if (sideband) parts.push(...sidebandPack(pack));
    else parts.push(pack);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------------------------
// Request body parsing for upload-pack.
// ----------------------------------------------------------------------------------------------

export interface UploadRequest {
  command: 'ls-refs' | 'fetch' | null;
  args: string[];
  fetch: FetchRequest;
  /** v0 want-line capabilities (fetch v0 only). */
  capabilities: string[];
  version2: boolean;
}

/** Parse an upload-pack POST body (v2 command form or v0 want/have form). Throws on garbage. */
export function parseUploadBody(body: Buffer): UploadRequest {
  const result: UploadRequest = {
    command: null,
    args: [],
    fetch: { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] },
    capabilities: [],
    version2: false,
  };
  let at = 0;
  let section: 'command' | 'args' | 'wants' | 'haves' = 'command';
  let firstLine = true;
  while (at < body.length) {
    const line = readPkt(body, at);
    at = line.next;
    if (line.payload === null) {
      if (section === 'wants') { section = 'haves'; continue; }
      break;
    }
    if (line.payload === 'delim') {
      if (section === 'command') section = 'args';
      continue;
    }
    let text = line.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine && text.startsWith('command=')) {
      result.version2 = true;
      result.command = text.slice('command='.length) as 'ls-refs' | 'fetch';
      section = 'command';
      firstLine = false;
      continue;
    }
    firstLine = false;
    if (result.version2) {
      if (section === 'command') {
        // Capability lines (agent=..., object-format=...) sit between command and delim.
        continue;
      }
      result.args.push(text);
      applyFetchArg(result.fetch, text);
      continue;
    }
    // v0: want lines, then shallow/deepen lines, flush, have lines, done.
    if (section === 'wants' || section === 'command') {
      section = 'wants';
      if (text.startsWith('want ')) {
        const fields = text.split(' ');
        result.fetch.wants.push(fields[1]!);
        if (fields.length > 2) result.capabilities = fields.slice(2);
      } else if (text.startsWith('shallow ')) {
        result.fetch.shallow.push(text.slice('shallow '.length).trim());
      } else if (text.startsWith('deepen ')) {
        result.fetch.deepen = Number(text.slice('deepen '.length));
      } else if (text.startsWith('deepen-since ')) {
        result.fetch.deepenSince = Number(text.slice('deepen-since '.length));
      } else if (text.startsWith('deepen-not ')) {
        result.fetch.deepenNot.push(text.slice('deepen-not '.length).trim());
      }
      continue;
    }
    if (section === 'haves') {
      if (text.startsWith('have ')) result.fetch.haves.push(text.slice('have '.length).trim());
      else if (text === 'done') break;
    }
  }
  return result;
}

function applyFetchArg(fetch: FetchRequest, arg: string): void {
  if (arg.startsWith('want ')) fetch.wants.push(arg.slice(5).trim());
  else if (arg.startsWith('have ')) fetch.haves.push(arg.slice(5).trim());
  else if (arg.startsWith('shallow ')) fetch.shallow.push(arg.slice(8).trim());
  else if (arg.startsWith('deepen ')) fetch.deepen = Number(arg.slice(7));
  else if (arg.startsWith('deepen-since ')) fetch.deepenSince = Number(arg.slice(13));
  else if (arg.startsWith('deepen-not ')) fetch.deepenNot.push(arg.slice(11).trim());
}

// ----------------------------------------------------------------------------------------------
// Receive-pack.
// ----------------------------------------------------------------------------------------------

export interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface ReceiveResult {
  /** Per-ref report lines ("ok <ref>" / "ng <ref> <reason>"), plus the unpack line first. */
  lines: string[];
  /** Whether report-status was requested (the answer is framed accordingly). */
  report: boolean;
  sideband: boolean;
}

/** Parse and apply a receive-pack body. Never throws: a bad pack reports an unpack failure. */
export function receivePack(repo: Repo, body: Buffer): ReceiveResult {
  const commands: RefCommand[] = [];
  const capabilities: string[] = [];
  let at = 0;
  try {
    let first = true;
    for (;;) {
      const line = readPkt(body, at);
      at = line.next;
      if (line.payload === null) break;
      if (line.payload === 'delim') continue;
      let text = line.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          capabilities.push(...text.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
          text = text.slice(0, nul);
        }
        first = false;
      }
      const fields = text.split(' ');
      if (fields.length >= 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
  } catch {
    return { lines: ['unpack invalid pkt-line stream'], report: true, sideband: false };
  }
  const report = capabilities.includes('report-status') || capabilities.includes('report-status-v2');
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = body.subarray(at);
  const hasPackWork = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackLine = 'unpack ok';
  if (hasPackWork && packBytes.length > 0) {
    try {
      const objects = parsePack(repo, packBytes);
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'corrupt pack'}`;
    }
  } else if (hasPackWork && packBytes.length === 0) {
    unpackLine = 'unpack no packfile was sent';
  }
  const lines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok';
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} ${unpackLine.slice('unpack '.length)}`);
      continue;
    }
    lines.push(applyRefCommand(repo, command, capabilities));
  }
  return { lines, report, sideband };
}

function applyRefCommand(repo: Repo, command: RefCommand, capabilities: string[]): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A delete: the server advertises delete-refs, and that advertisement is the permission —
    // clients are not required to repeat the capability in the command list.
    void capabilities;
    if (current === ZERO_OID) return `ng ${ref} reference does not exist`;
    if (current !== oldOid && oldOid !== ZERO_OID) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = repo.objects.get(newOid);
  if (target === undefined) return `ng ${ref} new object does not exist`;
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  // Fast-forward rule: the old commit must be an ancestor of the new commit (tags peel).
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(repo, oldCommit, newCommit)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

/** Frame a receive-pack report: plain pkt-lines, or wrapped in band-1 side-band packets. */
export function receiveReport(result: ReceiveResult): Buffer {
  if (!result.report) return Buffer.alloc(0);
  const lines = result.lines.map((line) => pkt(`${line}\n`));
  if (result.sideband) {
    const parts = lines.map((line) => pktBand(1, line));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([...lines, FLUSH]);
}
