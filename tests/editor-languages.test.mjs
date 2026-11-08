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

test('extended filenames and shebangs select bundled language support', async () => {
  for (const [path, name] of Object.entries({ '.zshrc': 'Shell', 'Dockerfile.dev': 'Dockerfile', Containerfile: 'Dockerfile', Jenkinsfile: 'Groovy', Gemfile: 'Ruby', 'config.jsonc': 'JSON', 'icon.svg': 'XML', 'component.vue': 'Vue', 'app.cs': 'C#', 'main.kt': 'Kotlin', 'main.swift': 'Swift', 'schema.proto': 'ProtoBuf', 'module.psm1': 'PowerShell', 'app.pyi': 'Python', 'build.cmake': 'CMake' })) {
    const language = languageFor(path);
    assert.equal(language?.name, name, path);
    assert.ok((await language.load()).language, path);
  }
  assert.equal(languageFor('script', '#!/usr/bin/env python3\nprint(1)').name, 'Python');
  assert.equal(languageFor('script', '#!/usr/bin/env -S node\nconsole.log(1)').name, 'JavaScript');
  assert.equal(languageFor('script', '#!/bin/bash\necho ok').name, 'Shell');
  assert.equal(languageFor('script', 'print(1)'), null);
  assert.equal(languageFor('constructor'), null);
  assert.equal(languageFor('file.__proto__'), null);
});
