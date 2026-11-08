import test from 'node:test';
import assert from 'node:assert/strict';
import { canDrop, movedPath } from '../src/explorer-transfer.mjs';

test('drop rejects descendants and same-folder moves but permits sibling copies', () => {
  assert.equal(canDrop('src', 'src/nested', true, true), false);
  assert.equal(canDrop('src', 'src', true, false), false);
  assert.equal(canDrop('src/a.ts', 'src', false, false), false);
  assert.equal(canDrop('src/a.ts', 'src', false, true), true);
  assert.equal(canDrop('src/a.ts', '', false, false), true);
  assert.equal(canDrop('src', 'src-other', true, false), true);
});
test('moving a folder updates only its own open paths on both platforms', () => {
  assert.equal(movedPath('src/a.ts', 'src', 'lib/src'), 'lib/src/a.ts');
  assert.equal(movedPath('src-other/a.ts', 'src', 'lib/src'), 'src-other/a.ts');
  assert.equal(movedPath('src\\nested\\a.ts', 'src', 'lib\\src'), 'lib/src/nested/a.ts');
  assert.equal(movedPath('a.ts', 'a.ts', 'lib/a.ts'), 'lib/a.ts');
});

test('multiple selection excludes descendants of already selected folders', async () => {
  const { topLevelEntries, selectedRange } = await import('../src/explorer-transfer.mjs');
  const folder = { path: 'src', directory: true };
  const sibling = { path: 'src-other/a.ts', directory: false };
  assert.deepEqual(topLevelEntries([folder, { path: 'src/a.ts', directory: false }, sibling, folder]), [folder, sibling]);
  assert.deepEqual(selectedRange(['a', 'b', 'c', 'd'], 'c', 'a'), ['a', 'b', 'c']);
  assert.deepEqual(selectedRange(['a'], 'missing', 'a'), ['a']);
});
