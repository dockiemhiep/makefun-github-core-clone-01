import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

process.env.MAKEFUN_SHOP_TOKEN = 'raw-http-test';
const { createApp } = await import('../app.ts');

const credentials = 'Host: localhost\r\nAuthorization: Bearer raw-http-test\r\n';

function request(method, path, body, headers = credentials) {
  const bytes = body === undefined ? '' : JSON.stringify(body);
  const length = body === undefined ? '' : `Content-Length: ${Buffer.byteLength(bytes)}\r\n`;
  return `${method} ${path} HTTP/1.1\r\n${headers}${length}\r\n${bytes}`;
}

async function open(t) {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const socket = connect(server.address().port, '127.0.0.1');
  t.after(async () => {
    socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await once(socket, 'connect');

  let pending = Buffer.alloc(0);
  const chunks = socket.iterator({ destroyOnReturn: false });
  async function more() {
    const next = await chunks.next();
    if (next.done) return false;
    pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
    return true;
  }

  async function response({ headOnly = false } = {}) {
    let end;
    while ((end = pending.indexOf('\r\n\r\n')) < 0) assert.ok(await more(), 'connection ended before headers');
    const [line, ...fields] = pending.toString('latin1', 0, end).split('\r\n');
    const status = Number(line.split(' ')[1]);
    const headers = Object.fromEntries(fields.map((field) => {
      const colon = field.indexOf(':');
      return [field.slice(0, colon).toLowerCase(), field.slice(colon + 1).trim()];
    }));
    const finish = end + 4 + (headOnly ? 0 : Number(headers['content-length'] ?? 0));
    while (pending.length < finish) assert.ok(await more(), 'connection ended before body');
    const data = pending.subarray(end + 4, finish);
    pending = pending.subarray(finish);
    return { status, headers, data, json: () => JSON.parse(data.toString()) };
  }

  async function exchange(...args) {
    socket.write(request(...args));
    return response();
  }

  async function remaining() {
    while (await more()) {}
    return pending;
  }

  return { socket, server, exchange, response, more, remaining };
}

test('HEAD on a warmed Git URL sends error headers without body bytes', { timeout: 5000 }, async (t) => {
  for (const { name, remove, headers, status, length } of [
    { name: 'head-denied', remove: false, headers: 'Host: localhost\r\n', status: 401, length: '30' },
    { name: 'head-deleted', remove: true, headers: credentials, status: 404, length: '24' },
  ]) {
    await t.test(name, async (t) => {
      const { socket, exchange, response, remaining } = await open(t);
      const ad = `/alice/${name}.git/info/refs?service=git-upload-pack`;
      assert.equal((await exchange('POST', '/api/v3/user/repos', { name })).status, 201);
      assert.equal((await exchange('GET', ad, undefined, credentials + 'Git-Protocol: version=2\r\n')).status, 200);
      if (remove) assert.equal((await exchange('DELETE', `/api/v3/repos/alice/${name}`)).status, 204);

      socket.end(request('HEAD', ad, undefined, headers));
      const head = await response({ headOnly: true });
      assert.equal(head.status, status);
      assert.equal(head.headers['content-length'], length);
      assert.equal((await remaining()).length, 0, 'bytes after the HEAD headers');
    });
  }
});

test('half-closing a short health request preserves the health response before the parser error', { timeout: 5000 }, async (t) => {
  const { socket, response, remaining } = await open(t);
  socket.end(`GET /healthz HTTP/1.1\r\n${credentials}Content-Length: 2\r\n\r\nx`);
  const health = await response();
  assert.equal(health.status, 200);
  assert.equal(health.data.toString(), '{"ok":true}\n');
  assert.equal((await remaining()).toString(), 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

test('pipelined issue create, read and close preserve bytes and invalidate the read cache', { timeout: 5000 }, async (t) => {
  const repo = '/api/v3/repos/alice/pipeline';
  const issues = `${repo}/issues`;
  const { socket, exchange, response } = await open(t);
  const title = 'Café 🧪 "\n';
  const body = 'body \\ end';
  socket.write(request('POST', '/api/v3/user/repos', { name: 'pipeline' }) +
    request('POST', issues, { title, body }) + request('GET', `${issues}/1`));
  assert.equal((await response()).status, 201);
  const created = await response();
  const first = await response();
  assert.equal(created.status, 201);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, created.data);
  assert.deepEqual(first.json(), { id: first.json().id, number: 1, title, body, state: 'open', labels: [] });

  const cached = await exchange('GET', `${issues}/1`);
  assert.deepEqual(cached.data, first.data);
  const denied = await exchange('GET', `${issues}/1`, undefined, 'Host: localhost\r\nAuthorization: bearer raw-http-test\r\n');
  assert.equal(denied.status, 401);

  socket.write(request('PATCH', `${issues}/1`, { state: 'closed' }) + request('GET', `${issues}/1`));
  const patched = await response();
  const closed = await response();
  assert.equal(patched.status, 200);
  assert.equal(closed.status, 200);
  assert.equal(closed.json().state, 'closed');
  assert.deepEqual(closed.data, patched.data);

  assert.equal((await exchange('POST', `${repo}/labels`, { name: 'ok' })).status, 201);
  const labelled = await exchange('POST', issues, { title: 'labelled', labels: ['ok'] });
  assert.equal(labelled.status, 201);
  assert.deepEqual(labelled.json().labels, [{ name: 'ok' }]);
});

test('DELETE 204 and same-socket recreation evict both issue routes', { timeout: 5000 }, async (t) => {
  const repo = '/api/v3/repos/alice/delete';
  const issues = `${repo}/issues`;
  const { socket, exchange, response } = await open(t);
  assert.equal((await exchange('POST', '/api/v3/user/repos', { name: 'delete' })).status, 201);
  assert.equal((await exchange('POST', issues, { title: 'old' })).status, 201);
  assert.equal((await exchange('GET', `${issues}/1`)).status, 200);

  socket.write(request('DELETE', repo) + request('POST', '/api/v3/user/repos', { name: 'delete' }) +
    request('GET', `${issues}/1`) + request('POST', issues, { title: 'new' }) + request('GET', `${issues}/1`));
  const deleted = await response();
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers['content-length'], undefined);
  assert.equal(deleted.headers['transfer-encoding'], undefined);
  assert.equal(deleted.headers.connection, 'keep-alive');
  assert.equal((await response()).status, 201);
  assert.equal((await response()).status, 404);
  const created = await response();
  assert.equal(created.status, 201);
  assert.equal(created.json().number, 1);
  const current = await response();
  assert.equal(current.status, 200);
  assert.equal(current.json().title, 'new');
  assert.deepEqual(current.data, created.data);
});

test('DELETE with Connection close sends 204 without length or body bytes', { timeout: 5000 }, async (t) => {
  const { socket, exchange, response, remaining } = await open(t);
  assert.equal((await exchange('POST', '/api/v3/user/repos', { name: 'delete-close' })).status, 201);
  socket.write(request('DELETE', '/api/v3/repos/alice/delete-close', undefined, credentials + 'Connection: close\r\n'));
  const deleted = await response({ headOnly: true });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers['content-length'], undefined);
  assert.equal(deleted.headers['transfer-encoding'], undefined);
  assert.equal(deleted.headers.connection, 'close');
  assert.equal((await remaining()).length, 0);
});

test('the pagination Link encodes a Latin-1 Host byte as UTF-8', { timeout: 5000 }, async (t) => {
  const { socket, exchange, response } = await open(t);
  for (const name of ['pagination-first', 'pagination-second']) {
    assert.equal((await exchange('POST', '/api/v3/user/repos', { name })).status, 201);
  }
  const headers = credentials.replace('localhost', 'café.example');
  socket.write(Buffer.from(request('GET', '/api/v3/user/repos?per_page=1', undefined, headers), 'latin1'));
  const page = await response();
  assert.equal(page.status, 200);
  assert.deepEqual(Buffer.from(page.headers.link, 'latin1'),
    Buffer.from('<http://café.example/api/v3/user/repos?per_page=1&page=2>; rel="next"', 'utf8'));
});

test('split request line, header terminator and UTF-8 body can precede a pipelined request', { timeout: 5000 }, async (t) => {
  const repo = '/api/v3/repos/alice/split';
  const issues = `${repo}/issues`;
  const { socket, response, exchange } = await open(t);
  assert.equal((await exchange('POST', '/api/v3/user/repos', { name: 'split' })).status, 201);
  assert.equal((await exchange('POST', issues, { title: 'warm' })).status, 201);
  const bytes = Buffer.from(request('POST', issues, { title: '🧪' }));
  const headers = bytes.indexOf('\r\n\r\n');
  const body = bytes.indexOf('🧪');
  const splits = [6, headers - 9, headers + 3, body + 2];
  let start = 0;
  for (const end of splits) {
    socket.write(bytes.subarray(start, end));
    start = end;
    await delay(15);
  }
  socket.write(Buffer.concat([bytes.subarray(start), Buffer.from(request('GET', `${issues}/2`))]));
  const created = await response();
  assert.equal(created.status, 201);
  assert.equal(created.json().title, '🧪');
  assert.deepEqual((await response()).data, created.data);
});

test('chunked and Expect handoffs preserve pipelined keep-alive requests', { timeout: 5000 }, async (t) => {
  const repo = '/api/v3/repos/alice/chunked';
  const issues = `${repo}/issues`;
  const { socket, response, exchange } = await open(t);
  socket.write(request('GET', '/healthz') +
    `POST /api/v3/user/repos HTTP/1.1\r\n${credentials}Transfer-Encoding: chunked\r\n\r\n` +
    '8\r\n{"name":\r\n9\r\n"chunked"\r\n1\r\n}\r\n0\r\n\r\n' + request('GET', '/healthz'));
  assert.equal((await response()).status, 200);
  assert.equal((await response()).status, 201);
  assert.equal((await response()).status, 200);

  assert.equal((await exchange('GET', repo)).status, 200);

  const second = await open(t);
  const body = '{"title":"after continue"}';
  second.socket.write(`POST ${issues} HTTP/1.1\r\n${credentials}Expect: 100-continue\r\nContent-Length: ${body.length}\r\n\r\n`);
  assert.equal((await second.response()).status, 100);
  second.socket.write(body + request('GET', '/healthz'));
  assert.equal((await second.response()).status, 201);
  assert.equal((await second.response()).status, 200);
  assert.equal((await second.exchange('GET', `${issues}/1`)).json().title, 'after continue');
});

test('Connection close handoff preserves response order and retires the socket', { timeout: 5000 }, async (t) => {
  const { socket, response, more } = await open(t);
  socket.write(request('GET', '/healthz') +
    request('GET', '/api/v3/meta', undefined, credentials + 'Connection: keep-alive, CLOSE\r\n'));
  assert.equal((await response()).status, 200);
  const closing = await response();
  assert.equal(closing.status, 200);
  assert.equal(closing.headers.connection, 'close');
  assert.equal(await more(), false);

  const proxy = await open(t);
  const proxied = await proxy.exchange('GET', '/healthz', undefined, credentials + 'Proxy-Connection: close\r\n');
  assert.equal(proxied.headers.connection, 'close');
  assert.equal(await proxy.more(), false);
});

test('duplicate auth and invalid or duplicate lengths reach the HTTP parser', { timeout: 5000 }, async (t) => {
  const duplicateAuth = await open(t);
  const wrongFirst = 'Host: localhost\r\nAuthorization: Bearer wrong\r\nAUTHORIZATION: Bearer raw-http-test\r\n';
  const duplicate = await duplicateAuth.exchange('GET', '/api/v3/meta', undefined, wrongFirst);
  assert.equal(duplicate.status, 401);
  assert.equal((await duplicateAuth.exchange('GET', '/api/v3/meta')).status, 200);

  const noHost = await open(t);
  assert.equal((await noHost.exchange('GET', '/healthz', undefined, '')).status, 400);

  for (const fields of ['Content-Length: 0\r\nContent-Length: 0\r\n', 'Content-Length: +0\r\n']) {
    const client = await open(t);
    const bad = await client.exchange('POST', '/api/v3/user/repos', undefined, credentials + fields);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.connection, 'close');
  }
});

test('bare LF is handled promptly by the native parser', { timeout: 5000 }, async (t) => {
  const { socket, response } = await open(t);
  socket.write('GET /healthz HTTP/1.1\nHost: localhost\n\n');
  assert.equal((await response()).status, 400);
});

test('backpressure keeps pipelined responses in order', { timeout: 5000 }, async (t) => {
  const { socket, exchange, response } = await open(t);
  const issues = '/api/v3/repos/alice/backpressure/issues';
  const body = 'x'.repeat(256 * 1024);
  assert.equal((await exchange('POST', '/api/v3/user/repos', { name: 'backpressure' })).status, 201);
  assert.equal((await exchange('POST', issues, { body })).status, 201);
  assert.equal((await exchange('GET', `${issues}/1`)).status, 200);

  socket.write(request('GET', `${issues}/1`) + request('GET', '/api/v3/meta'));
  const large = await response();
  assert.equal(large.status, 200);
  assert.equal(large.json().body, body);
  const meta = await response();
  assert.equal(meta.status, 200);
  assert.equal(meta.json().installed_version, 'makefun-forge-1');
});

test('closeIdleConnections and closeAllConnections cover raw and handed-off sockets', { timeout: 5000 }, async (t) => {
  const raw = await open(t);
  assert.equal((await raw.exchange('GET', '/healthz')).status, 200);
  const rawClosed = once(raw.socket, 'close');
  raw.server.closeIdleConnections();
  await rawClosed;

  const fallback = await open(t);
  await fallback.exchange('GET', '/healthz', undefined, credentials + 'Transfer-Encoding: chunked\r\n\r\n0\r\n');
  const fallbackClosed = once(fallback.socket, 'close');
  fallback.server.closeAllConnections();
  await fallbackClosed;
});
