import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, isNewerVersion } from '../src/updates.mjs';
test('stable version ordering is numeric', () => {
  assert.equal(isNewerVersion('0.9.9', 'v0.10.0'), true);
  assert.equal(isNewerVersion('1.0.0', 'v1.0.0'), false);
  assert.equal(isNewerVersion('2.0.0', 'v1.9.9'), false);
  assert.throws(() => isNewerVersion('1.0.0', 'v2.0.0-beta'));
});
test('update check validates releases and propagates offline failures', async () => {
  const mock = body => async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await checkRelease('0.1.0', mock({ tag_name: 'v0.2.0' })), { available: true, version: 'v0.2.0' });
  await assert.rejects(checkRelease('0.1.0', mock({ tag_name: 'v0.2.0', prerelease: true })));
  await assert.rejects(checkRelease('0.1.0', mock({ tag_name: '<script>' })));
  await assert.rejects(checkRelease('0.1.0', async () => ({ ok: false, status: 429 })));
  await assert.rejects(checkRelease('0.1.0', async () => { throw new Error('offline'); }));
});
