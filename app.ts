import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DELIM,
  FLUSH,
  ForgeStore,
  ZERO_OID,
  commitHistory,
  commitInfo,
  createCommit,
  decodeUntilFlush,
  deleteFile,
  filesAt,
  pkt,
  putFile,
  readPack,
  sidebandPack,
  tagTarget,
  v0Advertisement,
  v2Advertisement,
  writePack,
  type IssueRecord,
  type PullRecord,
  type Repository,
} from './forge.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const store = new ForgeStore();
const issueBodyCache = new WeakMap<IssueRecord, { state: IssueRecord['state']; body: Buffer }>();

function sendJsonText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': 'MF-FORGE', ...headers });
  res.end(text);
}

function sendJsonBytes(res: ServerResponse, status: number, body: Buffer): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': body.length, 'x-github-request-id': 'MF-FORGE' });
  res.end(body);
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendJsonText(res, status, text, headers);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, type: string): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(data);
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function authorised(req: IncomingMessage): boolean {
  return TOKEN !== '' && req.headers.authorization === `Bearer ${TOKEN}`;
}

function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner ?? store.viewer ?? ''}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.sendDate = false;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': '0', 'x-github-request-id': 'MF-FORGE' });
  res.end();
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const value = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

function issueJson(issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function sendIssue(res: ServerResponse, status: number, issue: IssueRecord): void {
  const cached = issueBodyCache.get(issue);
  if (cached?.state === issue.state) {
    sendJsonBytes(res, status, cached.body);
    return;
  }
  const body = Buffer.from(`${JSON.stringify(issueJson(issue))}\n`);
  issueBodyCache.set(issue, { state: issue.state, body });
  sendJsonBytes(res, status, body);
}

function pullJson(pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

function refOid(repo: Repository, ref: string | null): string | undefined {
  if (!ref || ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  return repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
}

function repoFromMatch(match: RegExpExecArray): Repository | null {
  try {
    return store.get(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  } catch {
    return null;
  }
}

function changedPaths(repo: Repository, baseSha: string, headSha: string): string[] {
  const base = filesAt(repo, baseSha);
  const head = filesAt(repo, headSha);
  return [...new Set([...base.keys(), ...head.keys()])].filter((path) => base.get(path)?.oid !== head.get(path)?.oid).sort();
}

function createIssue(repo: Repository, body: Record<string, unknown>): IssueRecord | null {
  const labels = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
  if (labels.some((label) => !repo.labels.has(label))) return null;
  const number = repo.nextIssue++;
  const issue: IssueRecord = {
    id: repo.id * 100_000 + number,
    number,
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

function createPull(repo: Repository, body: Record<string, unknown>): PullRecord | null {
  const head = typeof body.head === 'string' ? body.head.split(':').at(-1)! : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  const headSha = refOid(repo, head);
  const baseSha = refOid(repo, base);
  if (!headSha || !baseSha) return null;
  const number = repo.nextPull++;
  const pull: PullRecord = {
    id: repo.id * 100_000 + 50_000 + number,
    number,
    title: typeof body.title === 'string' ? body.title : '',
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open', head, base, headSha, baseSha,
    merged: false, mergedAt: null, mergeCommitSha: null,
    files: changedPaths(repo, baseSha, headSha),
  };
  repo.pulls.set(number, pull);
  return pull;
}

function mergePull(repo: Repository, pull: PullRecord): { ok: true; sha: string } | { ok: false } {
  const currentBase = refOid(repo, pull.base);
  if (!currentBase || pull.state !== 'open') return { ok: false };
  const originalBase = filesAt(repo, pull.baseSha);
  const currentFiles = filesAt(repo, currentBase);
  const headFiles = filesAt(repo, pull.headSha);
  if (currentBase !== pull.baseSha && pull.files.some((path) => originalBase.get(path)?.oid !== currentFiles.get(path)?.oid)) return { ok: false };
  for (const path of pull.files) {
    const file = headFiles.get(path);
    if (file) currentFiles.set(path, file);
    else currentFiles.delete(path);
  }
  const sha = createCommit(repo, currentFiles, currentBase, pull.title || 'Squash merge');
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  repo.generation += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = '2026-11-14T06:30:00Z';
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

function repositoryGraph(repo: Repository): Record<string, unknown> {
  return {
    id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueGraph(issue: IssueRecord): Record<string, unknown> {
  return { id: Buffer.from(`Issue:${issue.id}`).toString('base64'), number: issue.number, title: issue.title, body: issue.body, state: issue.state.toUpperCase() };
}

function pullGraph(pull: PullRecord): Record<string, unknown> {
  return {
    id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: 'MERGEABLE',
    state: pull.state.toUpperCase(),
    merged: pull.merged,
  };
}

function inputOf(variables: Record<string, unknown>): Record<string, unknown> {
  return typeof variables.input === 'object' && variables.input !== null && !Array.isArray(variables.input) ? variables.input as Record<string, unknown> : {};
}

function repoByGlobalId(id: unknown): Repository | null {
  if (typeof id !== 'string') return null;
  return [...store.repos.values()].find((repo) => repositoryGraph(repo).id === id) ?? null;
}

function issueByGlobalId(id: unknown): { repo: Repository; issue: IssueRecord } | null {
  if (typeof id !== 'string') return null;
  for (const repo of store.repos.values()) for (const issue of repo.issues.values()) if (issueGraph(issue).id === id) return { repo, issue };
  return null;
}

function pullByGlobalId(id: unknown): { repo: Repository; pull: PullRecord } | null {
  if (typeof id !== 'string') return null;
  for (const repo of store.repos.values()) for (const pull of repo.pulls.values()) if (pullGraph(pull).id === id) return { repo, pull };
  return null;
}

function graphRepo(variables: Record<string, unknown>): Repository | null {
  const owner = typeof variables.owner === 'string' ? variables.owner : '';
  const name = typeof variables.name === 'string' ? variables.name : '';
  return owner && name ? store.get(owner, name) : null;
}

function executeGraphQL(operation: Record<string, unknown>): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  const variables = typeof operation.variables === 'object' && operation.variables !== null && !Array.isArray(operation.variables)
    ? operation.variables as Record<string, unknown> : {};
  if (query.includes('noSuchFieldOnViewer')) return { errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }] };
  if (query.includes('query ViewerLogin')) return { data: { viewer: { login: store.viewer } } };
  if (query.includes('query Issue_fields')) {
    return { data: { Issue: { fields: ['id', 'number', 'title', 'state', 'body'].map((name) => ({ name })) } } };
  }
  if (query.includes('query PullRequestAndRepositoryFields')) {
    return { data: {
      PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].map((name) => ({ name })) },
      Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].map((name) => ({ name })) },
    } };
  }
  if (query.includes('query SearchType_enumValues')) return { data: { SearchType: { enumValues: [{ name: 'ISSUE' }] } } };
  if (query.includes('query RepositoryFields')) {
    const repo = graphRepo(variables);
    return { data: { repository: repo ? repositoryGraph(repo) : null } };
  }
  if (query.includes('query OpenIssues')) {
    const repo = graphRepo(variables);
    const first = typeof variables.first === 'number' ? variables.first : 10;
    const nodes = repo ? [...repo.issues.values()].filter((issue) => issue.state === 'open').sort((a, b) => b.number - a.number).slice(0, first).map(issueGraph) : [];
    return { data: { repository: repo ? { issues: { nodes } } : null } };
  }
  if (query.includes('query IssueByNumber')) {
    const repo = graphRepo(variables);
    const issue = repo?.issues.get(Number(variables.number));
    return { data: { repository: repo ? { issue: issue ? issueGraph(issue) : null } : null } };
  }
  if (query.includes('mutation IssueCreate')) {
    const input = inputOf(variables);
    const repo = repoByGlobalId(input.repositoryId);
    const issue = repo ? createIssue(repo, input) : null;
    return { data: { createIssue: { issue: issue ? issueGraph(issue) : null } } };
  }
  if (query.includes('mutation IssueClose')) {
    const found = issueByGlobalId(inputOf(variables).issueId);
    if (found) found.issue.state = 'closed';
    return { data: { closeIssue: { issue: found ? issueGraph(found.issue) : null } } };
  }
  if (query.includes('query PullRequests')) {
    const repo = graphRepo(variables);
    const first = typeof variables.first === 'number' ? variables.first : 5;
    const nodes = repo ? [...repo.pulls.values()].filter((pull) => pull.state === 'open').slice(0, first).map(pullGraph) : [];
    return { data: { repository: repo ? { pullRequests: { nodes } } : null } };
  }
  if (query.includes('query PullRequestFiles')) {
    const repo = graphRepo(variables);
    const pull = repo?.pulls.get(Number(variables.number));
    return { data: { repository: repo ? { pullRequest: pull ? { number: pull.number, files: { nodes: pull.files.slice(0, 10).map((path) => ({ path })) } } : null } : null } };
  }
  if (query.includes('query PullRequestId')) {
    const repo = graphRepo(variables);
    const pull = repo?.pulls.get(Number(variables.number));
    return { data: { repository: repo ? { pullRequest: pull ? { id: pullGraph(pull).id, number: pull.number } : null } : null } };
  }
  if (query.includes('mutation PullRequestCreate')) {
    const input = inputOf(variables);
    const repo = repoByGlobalId(input.repositoryId);
    const pull = repo ? createPull(repo, { head: input.headRefName, base: input.baseRefName, title: input.title, body: input.body }) : null;
    return { data: { createPullRequest: { pullRequest: pull ? pullGraph(pull) : null } } };
  }
  if (query.includes('mutation MergePullRequest')) {
    const found = pullByGlobalId(inputOf(variables).pullRequestId);
    if (found) mergePull(found.repo, found.pull);
    return { data: { mergePullRequest: { pullRequest: found ? pullGraph(found.pull) : null } } };
  }
  if (query.includes('mutation AddComment')) {
    const input = inputOf(variables);
    const found = issueByGlobalId(input.subjectId);
    const comment = found ? { id: store.nextCommentId++, body: typeof input.body === 'string' ? input.body : '' } : null;
    if (found && comment) found.issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: comment ? { id: Buffer.from(`Comment:${comment.id}`).toString('base64'), body: comment.body } : null } } } };
  }
  if (query.includes('query NodeRepository')) {
    const repo = repoByGlobalId(variables.id);
    const graph = repo ? repositoryGraph(repo) : null;
    return { data: { node: graph ? { id: graph.id, name: graph.name, nameWithOwner: graph.nameWithOwner } : null } };
  }
  if (query.includes('query IssuesPage')) {
    const repo = graphRepo(variables);
    const first = typeof variables.first === 'number' ? variables.first : 10;
    let offset = 0;
    if (typeof variables.after === 'string') {
      const decoded = Buffer.from(variables.after, 'base64').toString('utf8');
      if (decoded.startsWith('cursor:')) offset = Number(decoded.slice(7)) + 1;
    }
    const all = repo ? [...repo.issues.values()].sort((a, b) => a.number - b.number) : [];
    const page = all.slice(offset, offset + first);
    const end = offset + page.length - 1;
    return { data: { repository: repo ? { issues: { nodes: page.map((issue) => ({ number: issue.number })), pageInfo: { hasNextPage: offset + page.length < all.length, endCursor: page.length ? Buffer.from(`cursor:${end}`).toString('base64') : null } } } : null } };
  }
  return { errors: [{ message: 'Unknown operation' }] };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
  try {
    const parsed = JSON.parse((await readBody(req)).toString('utf8')) as unknown;
    if (Array.isArray(parsed)) sendJson(res, 200, parsed.map((operation) => executeGraphQL(operation as Record<string, unknown>)));
    else if (typeof parsed === 'object' && parsed !== null) sendJson(res, 200, executeGraphQL(parsed as Record<string, unknown>));
    else sendJson(res, 400, { errors: [{ message: 'Invalid request' }] });
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  }
}

const MCP_TOOLS = Object.freeze([
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List repository issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
]);

function rpc(id: unknown, result?: unknown, error?: { code: number; message: string }): Record<string, unknown> {
  return error ? { jsonrpc: '2.0', id: id ?? null, error } : { jsonrpc: '2.0', id: id ?? null, result };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function requiredString(args: Record<string, unknown>, name: string): string | null {
  return typeof args[name] === 'string' && args[name] !== '' ? args[name] as string : null;
}

function callMcpTool(name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  if (!MCP_TOOLS.some((tool) => tool.name === name)) return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  if (name === 'create_repo') {
    const repoName = requiredString(args, 'name');
    if (!repoName) return { error: { code: -32602, message: 'name is required' } };
    const repo = store.createRepo(repoName, { private: args.private === true, description: typeof args.description === 'string' ? args.description : '' });
    if (!repo) return { result: toolResult({ message: 'Repository already exists' }, true) };
    return { result: toolResult(repoJson(repo)) };
  }
  const owner = requiredString(args, 'owner');
  const repoName = requiredString(args, 'repo');
  if (!owner || !repoName) return { error: { code: -32602, message: 'owner and repo are required' } };
  const repo = store.get(owner, repoName);
  if (!repo) return { result: toolResult({ message: 'Not Found' }, true) };
  if (name === 'get_repo') return { result: toolResult(repoJson(repo)) };
  if (name === 'create_issue') {
    const title = requiredString(args, 'title');
    if (!title) return { error: { code: -32602, message: 'title is required' } };
    const issue = createIssue(repo, { title, body: args.body });
    return { result: toolResult(issueJson(issue!)) };
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state).map(issueJson);
    return { result: toolResult(issues) };
  }
  if (name === 'create_pull_request') {
    const title = requiredString(args, 'title');
    const head = requiredString(args, 'head');
    const base = requiredString(args, 'base');
    if (!title || !head || !base) return { error: { code: -32602, message: 'title, head and base are required' } };
    const pull = createPull(repo, { title, head, base, body: args.body });
    if (!pull) return { result: toolResult({ message: 'Pull request could not be created' }, true) };
    return { result: toolResult(pullJson(pull)) };
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.NaN;
    const pull = repo.pulls.get(number);
    if (!pull) return { error: { code: -32602, message: 'pull_number is invalid' } };
    const merged = mergePull(repo, pull);
    if (!merged.ok) return { result: toolResult({ message: 'Pull request is not mergeable' }, true) };
    return { result: toolResult({ number, sha: merged.sha, merged: true }) };
  }
  return { error: { code: -32601, message: 'Unknown tool' } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) { sendJson(res, 401, { message: 'Bad credentials' }); return; }
  let request: Record<string, unknown>;
  try {
    const parsed = JSON.parse((await readBody(req)).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid request');
    request = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, rpc(null, undefined, { code: -32700, message: 'Parse error' }));
    return;
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};
  if (method === 'server/discover') {
    sendJson(res, 200, rpc(id, {
      resultType: 'serverDiscovery',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-github-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'makefun-github-forge', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'tools/list') { sendJson(res, 200, rpc(id, { tools: MCP_TOOLS })); return; }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
    const answer = callMcpTool(name, args);
    sendJson(res, 200, answer.error ? rpc(id, undefined, answer.error) : rpc(id, answer.result));
    return;
  }
  sendJson(res, 200, rpc(id, undefined, { code: -32601, message: 'Method not found' }));
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  try {
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: 'makefun-forge-1' });
      return true;
    }
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30)));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      const repos = [...store.repos.values()].filter((repo) => repo.owner === store.viewer).sort((a, b) => a.id - b.id);
      const start = (page - 1) * perPage;
      const headers: Record<string, string> = {};
      if (start + perPage < repos.length) {
        const host = req.headers.host ?? '127.0.0.1';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(res, 200, repos.slice(start, start + perPage).map(repoJson), headers);
      return true;
    }
    if (method === 'POST' && path === '/api/v3/user/repos') {
      const body = await jsonBody(req);
      if (typeof body.name !== 'string' || body.name.length === 0) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      const repo = store.createRepo(body.name, { private: body.private === true, description: typeof body.description === 'string' ? body.description : '' });
      if (!repo) sendJson(res, 422, { message: 'Repository already exists' });
      else sendJson(res, 201, repoJson(repo));
      return true;
    }

    let match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(path);
    if (match && method === 'POST') {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else {
        const body = await jsonBody(req);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) sendJson(res, 422, { message: 'Validation Failed' });
        else { repo.refs.set(ref, sha); repo.generation += 1; sendJson(res, 201, { ref, object: { sha } }); }
      }
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(path);
    if (match && method === 'GET') {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else sendJson(res, 200, [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/heads/')).map(([name, sha]) => ({ name: name.slice(11), commit: { sha } })));
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(path);
    if (match && method === 'GET') {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else {
        const tip = refOid(repo, url.searchParams.get('sha'));
        sendJson(res, 200, commitHistory(repo, tip).map((sha) => ({ sha, commit: { message: commitInfo(repo.objects.get(sha)!.data).message } })));
      }
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      const filePath = decodeURIComponent(match[3]);
      if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
      if (method === 'GET') {
        const files = filesAt(repo, refOid(repo, url.searchParams.get('ref')));
        const file = files.get(filePath);
        if (file) sendJson(res, 200, { type: 'file', name: filePath.split('/').at(-1), path: filePath, encoding: 'base64', content: file.data.toString('base64'), sha: file.oid, size: file.data.length });
        else {
          const prefix = `${filePath.replace(/\/+$/, '')}/`;
          const names = new Map<string, { type: 'file' | 'dir'; path: string; sha: string }>();
          for (const [name, entry] of files) if (name.startsWith(prefix)) {
            const relative = name.slice(prefix.length);
            const first = relative.split('/')[0];
            if (relative.includes('/')) names.set(first, { type: 'dir', path: `${prefix}${first}`, sha: entry.oid });
            else names.set(first, { type: 'file', path: name, sha: entry.oid });
          }
          if (names.size === 0) sendJson(res, 404, { message: 'Not Found' });
          else sendJson(res, 200, [...names].map(([name, entry]) => ({ ...entry, name })));
        }
        return true;
      }
      if (method === 'PUT') {
        const body = await jsonBody(req);
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const current = filesAt(repo, refOid(repo, branch)).get(filePath);
        if (current && body.sha !== current.oid) sendJson(res, 409, { message: 'sha does not match' });
        else {
          const content = Buffer.from(typeof body.content === 'string' ? body.content : '', 'base64');
          const result = putFile(repo, branch, filePath, content, typeof body.message === 'string' ? body.message : 'Update file');
          sendJson(res, result.created ? 201 : 200, { content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } });
        }
        return true;
      }
      if (method === 'DELETE') {
        const body = await jsonBody(req);
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const current = filesAt(repo, refOid(repo, branch)).get(filePath);
        if (!current) sendJson(res, 404, { message: 'Not Found' });
        else if (typeof body.sha === 'string' && body.sha !== current.oid) sendJson(res, 409, { message: 'sha does not match' });
        else sendJson(res, 200, { commit: { sha: deleteFile(repo, branch, filePath, typeof body.message === 'string' ? body.message : 'Delete file') } });
        return true;
      }
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path);
    if (match && method === 'POST') {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else {
        const body = await jsonBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        repo.labels.set(name, color);
        sendJson(res, 201, { name, color });
      }
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      const issue = repo?.issues.get(Number(match[3]));
      if (!issue) sendJson(res, 404, { message: 'Not Found' });
      else if (method === 'GET') sendJson(res, 200, issue.comments);
      else if (method === 'POST') {
        const body = await jsonBody(req);
        const comment = { id: store.nextCommentId++, body: typeof body.body === 'string' ? body.body : '' };
        issue.comments.push(comment);
        sendJson(res, 201, comment);
      } else return false;
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      const issue = repo?.issues.get(Number(match[3]));
      if (!issue) sendJson(res, 404, { message: 'Not Found' });
      else if (method === 'GET') sendJson(res, 200, issueJson(issue));
      else if (method === 'PATCH') {
        const body = await jsonBody(req);
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        sendJson(res, 200, issueJson(issue));
      } else return false;
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else if (method === 'POST') {
        const issue = createIssue(repo, await jsonBody(req));
        if (!issue) sendJson(res, 422, { message: 'Validation Failed: label does not exist' });
        else sendJson(res, 201, issueJson(issue));
      } else if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state).sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
        sendJson(res, 200, issues.map(issueJson));
      } else return false;
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/.exec(path);
    if (match && method === 'GET') {
      const repo = repoFromMatch(match);
      const pull = repo?.pulls.get(Number(match[3]));
      if (!pull) sendJson(res, 404, { message: 'Not Found' });
      else {
        const base = filesAt(repo!, pull.baseSha);
        const head = filesAt(repo!, pull.headSha);
        sendJson(res, 200, pull.files.map((filename) => {
          const before = base.get(filename)?.data.toString('utf8') ?? '';
          const after = head.get(filename)?.data.toString('utf8') ?? '';
          const additions = Math.max(1, after.split('\n').length - (before ? before.split('\n').length : 0));
          const deletions = before && !after ? before.split('\n').length : 0;
          return { filename, status: before ? (after ? 'modified' : 'removed') : 'added', additions, deletions, changes: additions + deletions };
        }));
      }
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(path);
    if (match && method === 'PUT') {
      const repo = repoFromMatch(match);
      const pull = repo?.pulls.get(Number(match[3]));
      if (!pull) sendJson(res, 404, { message: 'Not Found' });
      else {
        await jsonBody(req);
        const result = mergePull(repo!, pull);
        if (!result.ok) sendJson(res, 405, { message: 'Pull Request is not mergeable' });
        else sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      }
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(path);
    if (match && method === 'GET') {
      const repo = repoFromMatch(match);
      const pull = repo?.pulls.get(Number(match[3]));
      if (!pull) sendJson(res, 404, { message: 'Not Found' });
      else sendJson(res, 200, pullJson(pull));
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else if (method === 'POST') {
        const pull = createPull(repo, await jsonBody(req));
        if (!pull) sendJson(res, 422, { message: 'Validation Failed' });
        else sendJson(res, 201, pullJson(pull));
      } else if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
        sendJson(res, 200, pulls.map(pullJson));
      } else return false;
      return true;
    }

    match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (match) {
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else if (method === 'GET') sendJson(res, 200, repoJson(repo));
      else if (method === 'PATCH') {
        const body = await jsonBody(req);
        if (typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(repo));
      } else if (method === 'DELETE') { store.repos.delete(repo.name); sendEmpty(res, 204); }
      else return false;
      return true;
    }
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  return false;
}

/** Fast dispatch for ordinary single-issue reads and issue creation. */
async function handleIssueHotPath(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  try {
    if (method === 'GET') {
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
      if (!match) return false;
      const issue = repoFromMatch(match)?.issues.get(Number(match[3]));
      if (!issue) sendJson(res, 404, { message: 'Not Found' });
      else sendIssue(res, 200, issue);
      return true;
    }
    if (method === 'POST') {
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path);
      if (!match) return false;
      const repo = repoFromMatch(match);
      if (!repo) sendJson(res, 404, { message: 'Not Found' });
      else {
        const issue = createIssue(repo, await jsonBody(req));
        if (!issue) sendJson(res, 422, { message: 'Validation Failed: label does not exist' });
        else sendIssue(res, 201, issue);
      }
      return true;
    }
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  return false;
}

function parseGitPath(path: string): { owner: string; name: string; suffix: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!match) return null;
  try {
    return { owner: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]), suffix: match[3] };
  } catch {
    return null;
  }
}

function gitContentType(service: string, kind: 'advertisement' | 'result'): string {
  return `application/x-${service}-${kind}`;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const wantsV2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  sendBytes(res, 200, body, gitContentType(service, 'advertisement'));
}

function handleLsRefs(res: ServerResponse, repo: Repository, lines: Buffer[]): void {
  const prefixes = lines.map((line) => line.toString()).filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11).trim());
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const rows: Buffer[] = [];
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD')) rows.push(pkt(main ? `${main} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  for (const [name, oid] of [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!matches(name)) continue;
    const target = name.startsWith('refs/tags/') && repo.objects.get(oid)?.type === 'tag' ? tagTarget(repo.objects.get(oid)!.data) : null;
    rows.push(pkt(`${oid} ${name}${target ? ` peeled:${target}` : ''}\n`));
  }
  rows.push(FLUSH);
  sendBytes(res, 200, Buffer.concat(rows), gitContentType('git-upload-pack', 'result'));
}

function fetchResponse(repo: Repository, lines: Buffer[]): Buffer {
  const text = lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
  const wants = text.filter((line) => line.startsWith('want ')).map((line) => line.split(' ')[1]);
  const haves = text.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
  const shallow = new Set(text.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8)));
  const depthLine = text.find((line) => line.startsWith('deepen '));
  const depth = depthLine ? Math.max(1, Number.parseInt(depthLine.slice(7), 10)) : Number.POSITIVE_INFINITY;
  const desired = repo.reachable(wants, depth);
  const already = repo.reachable(haves, Number.POSITIVE_INFINITY, shallow);
  for (const oid of already) desired.delete(oid);
  const objects = [...desired].map((oid) => repo.objects.get(oid)).filter((object) => object !== undefined);
  const pack = writePack(objects);
  const rows: Buffer[] = [];
  if (Number.isFinite(depth)) {
    const boundaries = new Set<string>();
    let level = new Set(wants);
    for (let generation = 1; generation < depth; generation += 1) {
      const next = new Set<string>();
      for (const oid of level) {
        const object = repo.objects.get(oid);
        if (object?.type === 'commit') for (const parent of commitInfo(object.data).parents) next.add(parent);
      }
      level = next;
    }
    for (const oid of level) {
      const object = repo.objects.get(oid);
      if (object?.type === 'commit' && commitInfo(object.data).parents.length > 0) boundaries.add(oid);
    }
    const shallowLines: string[] = [];
    for (const oid of shallow) if (!boundaries.has(oid)) shallowLines.push(`unshallow ${oid}\n`);
    for (const oid of boundaries) shallowLines.push(`shallow ${oid}\n`);
    if (shallowLines.length) {
      rows.push(pkt('shallow-info\n'), ...shallowLines.map(pkt), DELIM);
    }
  }
  rows.push(pkt('packfile\n'), ...sidebandPack(pack), FLUSH);
  return Buffer.concat(rows);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  try {
    const decoded = decodeUntilFlush(await readBody(req));
    const first = decoded.lines[0]?.toString().trim() ?? '';
    if (first === 'command=ls-refs') {
      let args = decoded.lines;
      if (decoded.rest.length) args = decodeUntilFlush(decoded.rest).lines;
      handleLsRefs(res, repo, args);
      return;
    }
    if (first === 'command=fetch') {
      const args = decoded.rest.length ? decodeUntilFlush(decoded.rest).lines : decoded.lines;
      sendBytes(res, 200, fetchResponse(repo, args), gitContentType('git-upload-pack', 'result'));
      return;
    }
    sendBytes(res, 400, Buffer.from('invalid upload-pack request'), 'text/plain');
  } catch {
    sendBytes(res, 400, Buffer.from('invalid upload-pack request'), 'text/plain');
  }
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repository): Promise<void> {
  try {
    const decoded = decodeUntilFlush(await readBody(req));
    if (decoded.rest.length) {
      for (const [oid, object] of readPack(decoded.rest)) repo.objects.set(oid, object);
    }
    const reports: Array<{ ref: string; ok: boolean; reason?: string }> = [];
    for (let index = 0; index < decoded.lines.length; index += 1) {
      const line = decoded.lines[index].toString('utf8').replace(/\n$/, '').split('\0')[0];
      const [oldOid, newOid, ref] = line.split(' ');
      const current = repo.refs.get(ref) ?? ZERO_OID;
      let reason = '';
      if (current !== oldOid) reason = 'stale-info';
      else if (newOid !== ZERO_OID && !repo.objects.has(newOid)) reason = 'missing-object';
      else if (oldOid !== ZERO_OID && newOid !== ZERO_OID && ref.startsWith('refs/heads/') && !repo.isAncestor(oldOid, newOid)) reason = 'non-fast-forward';
      if (reason) reports.push({ ref, ok: false, reason });
      else {
        if (newOid === ZERO_OID) repo.refs.delete(ref);
        else repo.refs.set(ref, newOid);
        repo.generation += 1;
        reports.push({ ref, ok: true });
      }
    }
    const inner = Buffer.concat([
      pkt('unpack ok\n'),
      ...reports.map((report) => pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`)),
      FLUSH,
    ]);
    const outer = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]);
    sendBytes(res, 200, outer, gitContentType('git-receive-pack', 'result'));
  } catch {
    const inner = Buffer.concat([pkt('unpack error\n'), FLUSH]);
    sendBytes(res, 200, Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), FLUSH]), gitContentType('git-receive-pack', 'result'));
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const git = parseGitPath(path);
    if (git) {
      if (!authorised(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const repo = store.get(git.owner, git.name);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://entry');
      if (method === 'GET' && git.suffix === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service === 'git-upload-pack' || service === 'git-receive-pack') handleInfoRefs(req, res, repo, service);
        else sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'POST' && git.suffix === 'git-upload-pack') {
        await handleUploadPack(req, res, repo);
        return;
      }
      if (method === 'POST' && git.suffix === 'git-receive-pack') {
        await handleReceivePack(req, res, repo);
        return;
      }
    }

    if (path === '/api/graphql' && method === 'POST') {
      await handleGraphQL(req, res);
      return;
    }

    if (path === '/mcp' && method === 'POST') {
      await handleMcp(req, res);
      return;
    }

    if (path.startsWith('/api/v3') && !authorised(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (path.startsWith('/api/v3') && await handleIssueHotPath(req, res, path, method)) return;

    if (path.startsWith('/api/v3') && await handleRest(req, res, path, method)) return;

    sendJson(res, 404, { message: 'Not Found' });
  });
}
