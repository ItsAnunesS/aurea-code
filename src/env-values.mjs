export function isEnvFile(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

/** Locate values without copying secrets into UI metadata. */
export function envValues(text) {
  const values = [];
  const assignment = /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*/gm;
  let match;
  while ((match = assignment.exec(text))) {
    const from = assignment.lastIndex;
    let to = from;
    const quote = text[from];
    if (quote === '"' || quote === "'" || quote === '`') {
      to++;
      while (to < text.length) {
        if (text[to] === '\\' && quote !== "'") { to += 2; continue; }
        if (text[to++] === quote) break;
      }
      to = Math.min(to, text.length);
    } else {
      while (to < text.length && !['\n', '\r', '#'].includes(text[to])) to++;
      while (to > from && /\s/.test(text[to - 1])) to--;
    }
    if (to > from) values.push({ from, to, name: match[1] });
    const lineEnd = text.indexOf('\n', to);
    assignment.lastIndex = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  return values;
}
