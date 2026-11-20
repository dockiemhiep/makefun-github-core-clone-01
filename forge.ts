import { createHash, hash } from 'node:crypto';
import { constants, createInflate, deflateSync, inflateSync, type Inflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjectType; data: Buffer }

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

export function hashObject(type: ObjectType, data: Uint8Array): string {
  const header = `${type} ${data.byteLength}\0`;
  // Small loose objects fit in one Buffer pool allocation. Stream larger objects
  // through the hash to avoid copying their contents.
  if (header.length + data.byteLength < Buffer.poolSize / 2) {
    const object = Buffer.allocUnsafe(header.length + data.byteLength);
    object.write(header, 'ascii');
    object.set(data, header.length);
    return hash('sha1', object);
  }
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function pkt(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export interface DecodedPackets { lines: Buffer[]; rest: Buffer }
export function decodeUntilFlush(body: Buffer): DecodedPackets {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line');
    const size = Number.parseInt(header, 16);
    offset += 4;
    if (size === 0 || size === 1 || size === 2) return { lines, rest: body.subarray(offset) };
    if (size === 3 || size > 65520 || offset + size - 4 > body.length) throw new Error('invalid pkt-line size');
    lines.push(body.subarray(offset, offset + size - 4));
    offset += size - 4;
  }
  throw new Error('truncated pkt-line stream');
}

function objectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let byte = (TYPE_CODE[type] << 4) | (remaining & 15);
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push(byte | 128);
    byte = remaining & 127;
    remaining >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) parts.push(objectHeader(object.type, object.data.length), deflateSync(object.data, { level: 1 }));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, hash('sha1', body, 'buffer')]);
}

function readObjectHeader(buffer: Buffer, start: number): { type: ObjectType; size: number; next: number } {
  let offset = start;
  let byte = buffer[offset++];
  if (byte === undefined) throw new Error('missing pack object header');
  const type = CODE_TYPE[(byte >>> 4) & 7];
  if (!type) throw new Error('unsupported delta pack object');
  let size = byte & 15;
  let shift = 4;
  while (byte & 128) {
    byte = buffer[offset++];
    if (byte === undefined) throw new Error('truncated pack object header');
    size += (byte & 127) * 2 ** shift;
    shift += 7;
  }
  return { type, size, next: offset };
}

const SMALL_INFLATE_LIMIT = 16 * 1024;
const OBJECT_HEADER_SPACE = 32;

interface InflateHandle {
  reset(): void;
  writeSync(flush: number, input: Buffer, start: number, length: number,
    output: Buffer, outputStart: number, outputLength: number): void;
}

interface SmallInflater {
  engine: Inflate;
  handle: InflateHandle;
  state: Uint32Array;
  scratch: Buffer;
}

interface InflatedObject {
  data: Buffer;
  consumed: number;
  oid: string;
}

// undefined means uninitialized or a discarded stream. null means no compatible binding.
let smallInflater: SmallInflater | null | undefined;

function createSmallInflater(): SmallInflater | null {
  try {
    const engine = createInflate({ chunkSize: SMALL_INFLATE_LIMIT }) as Inflate & {
      _handle?: InflateHandle;
      _writeState?: Uint32Array;
    };
    const handle = engine._handle;
    const state = engine._writeState;
    if (!handle || typeof handle.reset !== 'function' || typeof handle.writeSync !== 'function' ||
        !(state instanceof Uint32Array) || state.length < 2) {
      engine.close();
      return null;
    }
    // A binding error destroys the stream synchronously and emits this event later.
    engine.on('error', ignoreInflateError);
    return { engine, handle, state, scratch: Buffer.allocUnsafe(OBJECT_HEADER_SPACE + SMALL_INFLATE_LIMIT + 1) };
  } catch {
    return null;
  }
}

function ignoreInflateError(): void {}

function inflateSmallObject(pack: Buffer, start: number, size: number, type: ObjectType): InflatedObject | undefined {
  const length = pack.length - 20 - start;
  if (length <= 0 || !Number.isInteger(size) || size > SMALL_INFLATE_LIMIT) return;
  if (smallInflater === undefined) smallInflater = createSmallInflater();
  const inflater = smallInflater;
  if (!inflater) return;
  const { engine, handle, state, scratch } = inflater;
  try {
    handle.reset();
    if (!engine.destroyed) {
      // An extra byte distinguishes a completed stream from one that filled its output.
      handle.writeSync(constants.Z_FINISH, pack, start, length, scratch, OBJECT_HEADER_SPACE, size + 1);
      const consumed = length - state[1];
      if (!engine.destroyed && state[0] === 1 && consumed > 0 && consumed <= length) {
        const prefix = `${type} ${size}\0`;
        const objectStart = OBJECT_HEADER_SPACE - prefix.length;
        const objectEnd = OBJECT_HEADER_SPACE + size;
        scratch.write(prefix, objectStart, prefix.length, 'ascii');
        const oid = hash('sha1', scratch.subarray(objectStart, objectEnd));
        return { data: Buffer.from(scratch.subarray(OBJECT_HEADER_SPACE, objectEnd)), consumed, oid };
      }
    }
  } catch {
    // The public API below retains the original error and validation order.
  }
  smallInflater = undefined;
  engine.close();
}

function inflatePackObject(pack: Buffer, start: number, size: number, type: ObjectType): InflatedObject {
  const small = inflateSmallObject(pack, start, size, type);
  if (small) return small;
  const inflated = inflateSync(pack.subarray(start, -20), {
    info: true,
    maxOutputLength: Math.max(1, size),
    chunkSize: Math.max(64, Math.min(SMALL_INFLATE_LIMIT, size)),
  }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (inflated.buffer.length !== size || !inflated.engine.bytesWritten) throw new Error('bad pack object size');
  return { data: inflated.buffer, consumed: inflated.engine.bytesWritten, oid: hashObject(type, inflated.buffer) };
}

export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString() !== 'PACK' || pack.readUInt32BE(4) !== 2) throw new Error('invalid pack');
  const trailer = pack.subarray(pack.length - 20);
  const expected = hash('sha1', pack.subarray(0, -20), 'buffer');
  if (!trailer.equals(expected)) throw new Error('bad pack checksum');
  const count = pack.readUInt32BE(8);
  const result = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readObjectHeader(pack, offset);
    if (header.size > MAX_OBJECT_BYTES) throw new Error('pack object is too large');
    const { data, consumed, oid } = inflatePackObject(pack, header.next, header.size, header.type);
    offset = header.next + consumed;
    result.set(oid, { type: header.type, data });
  }
  if (offset !== pack.length - 20) throw new Error('trailing pack bytes');
  return result;
}

export function commitInfo(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n');
  return {
    tree: headers.find((line) => line.startsWith('tree '))?.slice(5) ?? ZERO_OID,
    parents: headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7)),
    message: split < 0 ? '' : text.slice(split + 2).replace(/\n$/, ''),
  };
}

export function treeEntries(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('invalid tree');
    entries.push({ mode: data.toString('ascii', offset, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

export function tagTarget(data: Buffer): string | null {
  return data.toString('utf8').split('\n').find((line) => line.startsWith('object '))?.slice(7) ?? null;
}

export interface FileEntry { oid: string; data: Buffer }

function readTreeFiles(repo: Repository, treeOid: string, prefix: string, files: Map<string, FileEntry>): void {
  const tree = repo.objects.get(treeOid);
  if (tree?.type !== 'tree') return;
  for (const entry of treeEntries(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const object = repo.objects.get(entry.oid);
    if (object?.type === 'tree') readTreeFiles(repo, entry.oid, path, files);
    else if (object?.type === 'blob') files.set(path, { oid: entry.oid, data: object.data });
  }
}

export function filesAt(repo: Repository, commitOid: string | undefined): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  if (!commitOid) return files;
  const commit = repo.objects.get(commitOid);
  if (commit?.type === 'commit') readTreeFiles(repo, commitInfo(commit.data).tree, '', files);
  return files;
}

function writeTree(repo: Repository, files: Map<string, FileEntry>, prefix = ''): string {
  const direct = new Map<string, FileEntry>();
  const dirs = new Set<string>();
  for (const [path, value] of files) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const slash = relative.indexOf('/');
    if (slash < 0) direct.set(relative, value);
    else dirs.add(relative.slice(0, slash));
  }
  const rows: Array<{ mode: string; name: string; oid: string }> = [];
  for (const [name, entry] of direct) rows.push({ mode: '100644', name, oid: entry.oid });
  for (const name of dirs) rows.push({ mode: '40000', name, oid: writeTree(repo, files, `${prefix}${name}/`) });
  rows.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
  const data = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from(`${row.mode} ${row.name}\0`), Buffer.from(row.oid, 'hex')])));
  return repo.put('tree', data);
}

export function createCommit(repo: Repository, files: Map<string, FileEntry>, parent: string | undefined, message: string): string {
  const tree = writeTree(repo, files);
  const identity = 'makefun <forge@make.fun> 1700000000 +0000';
  const data = Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${identity}\ncommitter ${identity}\n\n${message}\n`);
  return repo.put('commit', data);
}

export function putFile(repo: Repository, branch: string, path: string, data: Buffer, message: string): { commitSha: string; contentSha: string; created: boolean } {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const files = filesAt(repo, parent);
  const created = !files.has(path);
  const contentSha = repo.put('blob', data);
  files.set(path, { oid: contentSha, data });
  const commitSha = createCommit(repo, files, parent, message);
  repo.refs.set(ref, commitSha);
  repo.generation += 1;
  return { commitSha, contentSha, created };
}

export function deleteFile(repo: Repository, branch: string, path: string, message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const files = filesAt(repo, parent);
  if (!files.delete(path)) return null;
  const commitSha = createCommit(repo, files, parent, message);
  repo.refs.set(ref, commitSha);
  repo.generation += 1;
  return commitSha;
}

export function commitHistory(repo: Repository, tip: string | undefined): string[] {
  const commits: string[] = [];
  const seen = new Set<string>();
  const queue = tip ? [tip] : [];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    commits.push(oid);
    queue.push(...commitInfo(object.data).parents);
  }
  return commits;
}

export interface IssueRecord {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; comments: CommentRecord[];
}
export interface CommentRecord { id: number; body: string }
export interface PullRecord {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string;
  headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; files: string[];
}

export class Repository {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  readonly labels = new Map<string, string>();
  owner: string | null = null;
  description = '';
  defaultBranch = 'main';
  nextIssue = 1;
  nextPull = 1;
  generation = 0;
  private = false;
  readonly id: number;
  readonly name: string;

  constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  reachable(tips: Iterable<string>, depth = Number.POSITIVE_INFINITY, boundaries = new Set<string>()): Set<string> {
    const result = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [...tips].map((oid) => ({ oid, depth: 1 }));
    while (queue.length) {
      const current = queue.pop()!;
      if (result.has(current.oid)) continue;
      const object = this.objects.get(current.oid);
      if (!object) continue;
      result.add(current.oid);
      if (object.type === 'commit') {
        const info = commitInfo(object.data);
        queue.push({ oid: info.tree, depth: current.depth });
        if (current.depth < depth && !boundaries.has(current.oid)) {
          for (const parent of info.parents) queue.push({ oid: parent, depth: current.depth + 1 });
        }
      } else if (object.type === 'tree') {
        for (const entry of treeEntries(object.data)) queue.push({ oid: entry.oid, depth: current.depth });
      } else if (object.type === 'tag') {
        const target = tagTarget(object.data);
        if (target) queue.push({ oid: target, depth: current.depth });
      }
    }
    return result;
  }

  isAncestor(oldOid: string, newOid: string): boolean {
    if (oldOid === newOid) return true;
    const seen = new Set<string>();
    const stack = [newOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === oldOid) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object?.type === 'commit') stack.push(...commitInfo(object.data).parents);
    }
    return false;
  }
}

export class ForgeStore {
  readonly repos = new Map<string, Repository>();
  viewer: string | null = null;
  nextRepoId = 5000;
  nextCommentId = 1;

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repository | null {
    if (this.repos.has(name)) return null;
    const repo = new Repository(this.nextRepoId++, name);
    repo.private = options.private === true;
    repo.description = options.description ?? '';
    repo.owner = this.viewer;
    this.repos.set(name, repo);
    return repo;
  }

  claim(owner: string): void {
    if (this.viewer === null) {
      this.viewer = owner;
      for (const repo of this.repos.values()) if (repo.owner === null) repo.owner = owner;
    }
  }

  get(owner: string, name: string): Repository | null {
    this.claim(owner);
    const repo = this.repos.get(name);
    return repo?.owner === owner && owner === this.viewer ? repo : null;
  }
}

export function v0Advertisement(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1'
    : 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=makefun-forge/1';
  const rows: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const advertised: Array<[string, string]> = main ? [['HEAD', main], ...refs] : refs;
  if (advertised.length === 0) rows.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  else {
    advertised.forEach(([name, oid], index) => {
      rows.push(pkt(`${oid} ${name}${index === 0 ? `\0${caps}` : ''}\n`));
      if (name.startsWith('refs/tags/')) {
        const target = repo.objects.get(oid)?.type === 'tag' ? tagTarget(repo.objects.get(oid)!.data) : null;
        if (target) rows.push(pkt(`${target} ${name}^{}\n`));
      }
    });
  }
  rows.push(FLUSH);
  return Buffer.concat(rows);
}

const V2_ADVERTISEMENT = Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=makefun-forge/1\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

export function sidebandPack(pack: Buffer): Buffer[] {
  const rows: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 60_000) rows.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 60_000)])));
  return rows;
}
