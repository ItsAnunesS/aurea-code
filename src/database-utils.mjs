/** Escape CSV cells, including spreadsheet formula prefixes. */
export function resultCsv(columns, rows) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return [columns, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
export function changedRows(rows, changes) {
  return [...changes.entries()].map(([index, values]) => ({ original: rows[index], values: Object.fromEntries(values) }));
}
