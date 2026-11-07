import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultCsv, changedRows } from '../src/database-utils.mjs';
test('CSV escapes quotes, newlines and spreadsheet formulas', () => {
  assert.equal(resultCsv(['label', 'value'], [['a"b\nc', '=HYPERLINK("bad")'], [null, '1234567890123456.1234']]), '"label","value"\r\n"a""b\nc","\'=HYPERLINK(""bad"")"\r\n"","1234567890123456.1234"');
});
test('staged updates retain original row and distinguish null from empty strings', () => {
  const original = [['1', null], ['2', 'before']];
  const changes = new Map([[1, new Map([['label', '']])]]);
  assert.deepEqual(changedRows(original, changes), [{ original: ['2', 'before'], values: { label: '' } }]);
  assert.equal(original[1][1], 'before');
});
