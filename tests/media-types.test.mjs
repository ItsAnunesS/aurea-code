import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaType } from '../src/media-types.mjs';
test('media previews use an explicit extension allowlist', () => {
  for (const [path, type] of Object.entries({ 'asset.PNG': 'image/png', 'folder/a.webp': 'image/webp', 'C:\\assets\\a.svg': 'image/svg+xml', 'manual.pdf': 'application/pdf', 'a.avif': 'image/avif' })) assert.equal(mediaType(path), type);
  for (const path of ['image.png.js', 'index.html', 'a.txt', 'script.svg.html', '__proto__', 'constructor', 'file.toString']) assert.equal(mediaType(path), null);
});
