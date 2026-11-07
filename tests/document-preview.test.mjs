import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentKind, renderDocument, resolveDocumentLink } from '../src/document-renderer.mjs';

test('documentation detection includes Markdown and text documentation only', () => {
  for (const path of ['README.MD', 'docs/guide.markdown', 'notes.mdown']) assert.equal(documentKind(path), 'markdown');
  for (const path of ['README', 'docs/LICENSE', 'manual.txt', 'guide.rst', 'guide.adoc']) assert.equal(documentKind(path), 'text');
  for (const path of ['.env', 'index.html', 'script.ts']) assert.equal(documentKind(path), null);
});
test('Markdown renders headings, tables, nested lists and code', () => {
  const output = renderDocument('README.md', '# Guide\n\n**Bold**\n\n- One\n  - Nested\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\n```js\nconst value = 1;\n```');
  for (const tag of ['<h1>', '<strong>', '<ul>', '<table>', '<code class="language-js">']) assert.ok(output.includes(tag), tag);
});
test('preview cannot execute document HTML or load images', () => {
  const output = renderDocument('README.md', '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![remote](https://example.com/tracker.png)\n\n[bad](javascript:alert(1))\n\n[good](guide.md)');
  assert.doesNotMatch(output, /<script|<img|href=/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /data-document-link="guide.md"/);
  assert.equal(renderDocument('LICENSE', '<script>test</script>'), '<pre class="document-text">&lt;script&gt;test&lt;/script&gt;</pre>');
});
test('document links stay within the project and reject unsupported protocols', () => {
  assert.deepEqual(resolveDocumentLink('docs/guide.md', '../README.md'), { path: 'README.md' });
  assert.deepEqual(resolveDocumentLink('README.md', 'https://example.com'), { external: 'https://example.com/' });
  for (const href of ['../../private', 'file:///etc/passwd', 'javascript:alert(1)', '//example.com', '/etc/passwd']) assert.throws(() => resolveDocumentLink('docs/guide.md', href));
});
