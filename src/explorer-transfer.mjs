export const normalizePath = path => path.replaceAll('\\', '/');
export function movedPath(path, source, destination) {
  const current = normalizePath(path);
  const from = normalizePath(source);
  return current === from || current.startsWith(`${from}/`)
    ? normalizePath(destination) + current.slice(from.length) : path;
}
export function canDrop(source, destination, directory, copy) {
  source = normalizePath(source); destination = normalizePath(destination);
  if (!source || (directory && (destination === source || destination.startsWith(`${source}/`)))) return false;
  return copy || source.split('/').slice(0, -1).join('/') !== destination;
}

export function topLevelEntries(entries) {
  const unique = [...new Map(entries.map(entry => [normalizePath(entry.path), entry])).values()];
  return unique.filter(entry => !unique.some(parent => parent !== entry && parent.directory && normalizePath(entry.path).startsWith(`${normalizePath(parent.path)}/`)));
}
export function selectedRange(paths, anchor, target) {
  const start = paths.indexOf(anchor), end = paths.indexOf(target);
  return start < 0 || end < 0 ? [target] : paths.slice(Math.min(start, end), Math.max(start, end) + 1);
}
