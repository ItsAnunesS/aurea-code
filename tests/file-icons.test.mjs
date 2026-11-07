import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileIconFor, fileIconMarkup } from '../src/file-icons.mjs';
test('file icons identify languages, dialects and special project files', () => {
  for (const [path, kind] of Object.entries({ 'src/app.ts': 'typescript', 'APP.JS': 'javascript', 'src/App.tsx': 'react', 'main.rs': 'rust', 'main.py': 'python', 'styles.css': 'css', 'README.md': 'markdown', '.env.local': 'env', Dockerfile: 'docker', 'compose.yaml': 'docker', '.gitignore': 'git', 'Cargo.lock': 'lock', 'package-lock.json': 'lock', 'Cargo.toml': 'package', 'C:\\repo\\main.go': 'go', 'icon.svg': 'image', 'LICENSE': 'document', 'unknown.bin': 'file' })) {
    assert.equal(fileIconFor(path).kind, kind, path);
  }
});
test('untrusted filenames cannot inject SVG markup or attributes', () => {
  const markup = fileIconMarkup('<img src=x onerror=alert(1)>.ts');
  assert.ok(markup.includes('data-file-kind="typescript"'));
  assert.doesNotMatch(markup, /onerror|<img|alert/);
  assert.ok(markup.includes('aria-hidden="true"'));
});
