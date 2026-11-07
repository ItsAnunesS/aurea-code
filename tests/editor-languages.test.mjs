import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageFor } from '../src/languages.mjs';
import { envValues, isEnvFile } from '../src/env-values.mjs';

test('language detection handles paths, case, dialects and special filenames', async () => {
  for (const [path, name] of Object.entries({ 'src/main.ts': 'TypeScript', 'Component.TSX': 'TSX', 'main.rs': 'Rust', 'app.py': 'Python', 'main.go': 'Go', 'index.html': 'HTML', 'app.css': 'CSS', 'config.yaml': 'YAML', 'README.md': 'Markdown', Dockerfile: 'Dockerfile', 'C:\\project\\query.sql': 'SQL', 'app.mts': 'TypeScript' })) {
    const language = languageFor(path);
    assert.equal(language?.name, name, path);
    assert.ok((await language.load()).language, path);
  }
  assert.equal(languageFor('folder.js/unknown.xyz'), null);
});

test('environment filenames and value boundaries preserve keys and comments', () => {
  for (const path of ['.env', 'config/.env.local', 'C:\\config\\production.env']) assert.ok(isEnvFile(path));
  assert.equal(isEnvFile('environment.ts'), false);
  const text = '# comment\nexport TOKEN = "secret#quoted" # note\nEMPTY=\nURL=https://host/path\nMULTI="first\nSECOND=still-secret\nlast"\nOTHER=abc#comment\n';
  const values = envValues(text);
  assert.deepEqual(values.map(v => v.name), ['TOKEN', 'URL', 'MULTI', 'OTHER']);
  assert.deepEqual(values.map(v => text.slice(v.from, v.to)), ['"secret#quoted"', 'https://host/path', '"first\nSECOND=still-secret\nlast"', 'abc']);
  assert.deepEqual(envValues('KEY="unfinished\nsecret').map(v => v.to), [22]);
});
