import test from 'node:test';
import assert from 'node:assert/strict';
import { updateManifest } from '../scripts/update-manifest.mjs';
const assets = ['Aurea-Code-1.2.3-x86_64.AppImage'].map(name => ({ name, signature: 'public-signature' }));
test('updater manifest keeps installer types and immutable versioned URLs', () => {
  const result = updateManifest('1.2.3', assets);
  assert.equal(result.version, '1.2.3');
  assert.match(result.platforms['linux-x86_64'].url, /\/v1.2.3\/Aurea-Code-1.2.3-x86_64.AppImage$/);
  assert.deepEqual(Object.keys(result.platforms).sort(), ['linux-x86_64', 'linux-x86_64-appimage']);
  assert.deepEqual(result.platforms['linux-x86_64-appimage'], result.platforms['linux-x86_64']);
});
test('updater publication rejects incomplete, unsigned or mismatched releases', () => {
  assert.throws(() => updateManifest('1.2.3', assets.slice(1)));
  assert.throws(() => updateManifest('1.2.3', [...assets, assets[0]]));
  assert.throws(() => updateManifest('1.2.3', assets.map(a => ({ ...a, signature: '' }))));
  assert.throws(() => updateManifest('2.0.0', assets));
  assert.throws(() => updateManifest('../bad', assets));
});
