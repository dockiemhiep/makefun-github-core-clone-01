import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { hashObject, readPack, writePack } from '../forge.ts';

const SMALL_LIMIT = 16 * 1024;

test('pack reads preserve independent small object bytes after reuse', () => {
  const objects = [
    { type: 'blob', data: Buffer.alloc(0) },
    { type: 'commit', data: Buffer.from('small commit data') },
    { type: 'tree', data: Buffer.alloc(SMALL_LIMIT, 33) },
    { type: 'blob', data: Buffer.alloc(SMALL_LIMIT + 1, 44) },
  ];
  const parsed = readPack(writePack(objects));
  readPack(writePack([{ type: 'blob', data: Buffer.alloc(SMALL_LIMIT, 55) }]));
  assert.equal(parsed.size, objects.length);
  for (const object of objects) {
    assert.deepEqual(parsed.get(hashObject(object.type, object.data)), object);
  }
});

function seal(body) {
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

test('a valid pack trailer cannot hide truncated deflate or an invalid object size', () => {
  const object = { type: 'blob', data: Buffer.from('payload') };
  const valid = writePack([object]);
  // Strip the pack trailer and then truncate the compressed stream itself.
  assert.throws(() => readPack(seal(valid.subarray(0, -22))), { code: 'Z_BUF_ERROR' });
  const corrupt = Buffer.from(valid.subarray(0, -20));
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => readPack(seal(corrupt)), { code: 'Z_DATA_ERROR' });
  const wrongSize = Buffer.from(valid.subarray(0, -20));
  wrongSize[12] += 1;
  assert.throws(() => readPack(seal(wrongSize)), /bad pack object size/);
  assert.deepEqual(readPack(valid).get(hashObject(object.type, object.data)), object);
});
