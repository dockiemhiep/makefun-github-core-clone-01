import assert from 'node:assert/strict';
import { Agent, request } from 'node:http';
import { test } from 'node:test';

process.env.MAKEFUN_SHOP_TOKEN = 'body-limit-test';
const { createApp } = await import('../app.ts');

test('accept the body limit, reject overflow with JSON, and keep serving', { timeout: 30_000 }, async () => {
  const server = createApp();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (path, body) => new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = request(origin + path, {
      method: 'POST', agent,
      headers: { authorization: 'Bearer body-limit-test', 'content-length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });

  try {
    assert.equal((await post('/api/v3/user/repos', { name: 'body-limits' })).status, 201);
    const limit = 64 * 1024 * 1024;
    const body = Buffer.alloc(limit + 1, 0x20);
    body.write('{}');
    const path = '/api/v3/repos/alice/body-limits/issues';

    const accepted = await post(path, body.subarray(0, limit));
    assert.equal(accepted.status, 201);
    assert.equal(JSON.parse(accepted.text).number, 1);

    const rejected = await post(path, body);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.text, '{"message":"Problems parsing JSON"}\n');

    const control = await post(path, { title: 'after overflow' });
    assert.equal(control.status, 201);
    assert.equal(JSON.parse(control.text).number, 2);
    assert.equal(JSON.parse(control.text).title, 'after overflow');
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
