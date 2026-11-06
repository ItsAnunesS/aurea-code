export function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
/** @returns {{ id: string, name: string, image: string, state: string, status: string, ports: string }[]} */
export function parseContainers(output) {
  return output.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const value = JSON.parse(line);
    if (typeof value.ID !== 'string' || !/^[a-f0-9]{12,64}$/i.test(value.ID)) throw new Error('Resposta Docker inválida.');
    return { id: value.ID, name: String(value.Names ?? ''), image: String(value.Image ?? ''), state: String(value.State ?? ''), status: String(value.Status ?? ''), ports: String(value.Ports ?? '') };
  });
}
export function languageFor(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension)) return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'rs') return 'rust';
  return 'text';
}
