import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, parseContainers, languageFor } from '../src/utils.mjs';
test('project and CLI output cannot inject HTML', () => { assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'); assert.equal(escapeHtml("a'b&c"), 'a&#39;b&amp;c'); });
test('Docker JSON lines support empty lists and multiple containers', () => { assert.deepEqual(parseContainers(''), []); const rows = parseContainers('{"ID":"0123456789ab","Names":"api","State":"running"}\r\n{"ID":"abcdef012345","Names":"db"}\n'); assert.equal(rows.length, 2); assert.equal(rows[0].state, 'running'); assert.equal(rows[1].name, 'db'); });
test('invalid Docker identifiers and malformed data are rejected', () => { assert.throws(() => parseContainers('{"ID":"--all"}')); assert.throws(() => parseContainers('not json')); });
test('editor selects a supported syntax and falls back to plain text', () => { assert.equal(languageFor('src/main.ts'), 'javascript'); assert.equal(languageFor('src/lib.rs'), 'rust'); assert.equal(languageFor('README.md'), 'text'); });
