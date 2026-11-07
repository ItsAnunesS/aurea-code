import test from 'node:test';
import assert from 'node:assert/strict';
import { updateManifest } from '../scripts/update-manifest.mjs';
const assets = ['Aurea-Code-1.2.3-x86_64.AppImage', 'Aurea Code_1.2.3_x64-setup.exe', 'Aurea Code_1.2.3_x64_en-US.msi'].map(name => ({ name, signature: 'public-signature' }));
test('updater manifest keeps installer types and immutable versioned URLs', () => {
  const result = updateManifest('1.2.3', assets);
  assert.equal(result.version, '1.2.3');
  assert.match(result.platforms['linux-x86_64'].url, /\/v1.2.3\/Aurea-Code-1.2.3-x86_64.AppImage$/);
  assert.match(result.platforms['windows-x86_64-nsis'].url, /Aurea%20Code.*\.exe$/);
  assert.match(result.platforms['windows-x86_64-msi'].url, /\.msi$/);
});
test('updater publication rejects incomplete, unsigned or mismatched releases', () => {
  assert.throws(() => updateManifest('1.2.3', assets.slice(1)));
  assert.throws(() => updateManifest('1.2.3', [...assets, assets[0]]));
  assert.throws(() => updateManifest('1.2.3', assets.map(a => ({ ...a, signature: '' }))));
  assert.throws(() => updateManifest('2.0.0', assets));
  assert.throws(() => updateManifest('../bad', assets));
});
