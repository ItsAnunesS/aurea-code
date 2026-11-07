import { languageFor } from './languages.mjs';
import { isEnvFile } from './env-values.mjs';

const shapes = {
  code: '<path d="m8 6-5 6 5 6m8-12 5 6-5 6m-3-15-2 18"/>',
  react: '<ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  rust: '<path d="m9 2 1 2h4l1-2 3 2-1 2 2 3 3 1v4l-3 1-2 3 1 2-3 2-1-2h-4l-1 2-3-2 1-2-2-3-3-1v-4l3-1 2-3-1-2Z"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9m4 0 3 4"/>',
  python: '<path fill="#7aa7d5" stroke="none" d="M12 2C7 2 7 4 7 6v3h6v1H5c-4 0-4 8 0 8h2v-4c0-2 2-3 4-3h6V6c0-3-1-4-5-4Z"/><path fill="#e5c777" stroke="none" d="M12 22c5 0 5-2 5-4v-3h-6v-1h8c4 0 4-8 0-8h-2v4c0 2-2 3-4 3H7v5c0 3 1 4 5 4Z"/><circle cx="10" cy="5" r="1" fill="#192024" stroke="none"/><circle cx="14" cy="19" r="1" fill="#192024" stroke="none"/>',
  html: '<path d="m4 3 2 17 6 2 6-2 2-17Zm4 5h8l-1 8-3 1-3-1-.3-3H15"/>',
  css: '<path d="m4 3 2 17 6 2 6-2 2-17ZM8 8h8l-5 4h4l-1 4-2 1-3-1"/>',
  json: '<path d="M9 3H7v7l-3 2 3 2v7h2m6-18h2v7l3 2-3 2v7h-2"/><circle cx="12" cy="8" r=".7" fill="currentColor"/><circle cx="12" cy="16" r=".7" fill="currentColor"/>',
  markdown: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 16V8l3 4 3-4v8m6-8v8m-3-3 3 3 3-3"/>',
  docker: '<path d="M2 12h17l3-3c0 8-4 12-11 12-5 0-8-3-9-9Z"/><path d="M5 12V8h4v4m0-4V4h4v8m0-4h4v4"/>',
  git: '<path d="m12 2 10 10-10 10L2 12Z"/><path d="m8 6 8 8m-4-4v8"/><circle cx="12" cy="10" r="1.5"/><circle cx="12" cy="17" r="1.5"/><circle cx="16" cy="14" r="1.5"/>',
  env: '<path d="M5 3h10l4 4v14H5Z"/><circle cx="10" cy="13" r="2"/><path d="M12 13h4m-1 0v2"/>',
  config: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="#202529"/><circle cx="16" cy="12" r="2" fill="#202529"/><circle cx="10" cy="18" r="2" fill="#202529"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3m6 0h6"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  document: '<path d="M5 2h9l5 5v15H5Zm9 0v6h5M8 12h8M8 16h8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 18 6-6 4 4 3-3 5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  package: '<path d="m12 2 10 5v10l-10 5-10-5V7Zm-10 5 10 5 10-5M12 12v10M7 4l10 5v5"/>',
  folder: '<path d="M2 6V4h7l3 3h10v13H2Z"/>',
};
const languageIcons = {
  JavaScript: ['javascript', '#e5ce75', 'JS'], TypeScript: ['typescript', '#79b3ec', 'TS'],
  JSX: ['react', '#79cbdc', 'react'], TSX: ['react', '#79b3ec', 'react'],
  Python: ['python', '#7aa7d5', 'python'], Rust: ['rust', '#dba889', 'rust'],
  HTML: ['html', '#e29371', 'html'], CSS: ['css', '#9ab5ee', 'css'],
  Sass: ['sass', '#d798b8', 'S'], SCSS: ['sass', '#d798b8', 'S'],
  JSON: ['json', '#dfc18c', 'json'], Markdown: ['markdown', '#9fc2db', 'markdown'],
  Dockerfile: ['docker', '#7dbce0', 'docker'], Shell: ['shell', '#a4c78e', 'terminal'],
  PowerShell: ['powershell', '#8ab4e5', 'terminal'], SQL: ['sql', '#d4b68b', 'database'],
  YAML: ['yaml', '#d59ba7', 'config'], TOML: ['toml', '#bba5db', 'config'],
  Go: ['go', '#7bcbd2', 'GO'], Java: ['java', '#dfad86', 'J'],
  C: ['c', '#99b9db', 'C'], 'C++': ['cpp', '#99b9db', 'C+'], 'C#': ['csharp', '#b7a0de', 'C#'],
  PHP: ['php', '#afa6d8', 'PHP'], Ruby: ['ruby', '#db9297', 'Rb'],
  Swift: ['swift', '#e9a07f', 'Sw'], Kotlin: ['kotlin', '#c1a2e0', 'Kt'],
  Vue: ['vue', '#9bc7a2', 'V'], XML: ['xml', '#c9b782', 'code'],
};

/** Return only fixed icon metadata, never file contents or user-provided SVG. */
export function fileIconFor(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  const fixed = (kind, color, shape, label) => ({ kind, color, shape, label });
  if (isEnvFile(path)) return fixed('env', '#d4bd84', 'env', 'Environment');
  if (/^dockerfile(?:\.|$)/.test(name) || /^(docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(name)) return fixed('docker', '#7dbce0', 'docker', 'Docker');
  if (/^\.git/.test(name)) return fixed('git', '#de9a7e', 'git', 'Git');
  if (name.endsWith('.lock') || /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(name)) return fixed('lock', '#a5afb9', 'lock', 'Dependency lockfile');
  if (['package.json', 'cargo.toml', 'go.mod', 'pyproject.toml', 'composer.json'].includes(name)) return fixed('package', '#cbb58c', 'package', 'Package manifest');
  if (/\.(png|jpe?g|gif|svg|webp|ico|avif)$/.test(name)) return fixed('image', '#b5a3d6', 'image', 'Image');
  if (/\.(txt|rst|adoc|pdf)$/.test(name) || /^(readme|license|licence|notice|copying)(\.|$)/.test(name) && !/\.(md|markdown|mdown|mkd)$/.test(name)) return fixed('document', '#aebfcb', 'document', 'Document');
  const language = languageFor(path);
  const entry = languageIcons[language?.name];
  if (entry) return fixed(entry[0], entry[1], entry[2], language.name);
  return language ? fixed('code', '#a5b7c4', 'code', language.name) : fixed('file', '#909ca7', 'document', 'File');
}
export function fileIconMarkup(path) {
  const { kind, color, shape } = fileIconFor(path);
  const contents = shapes[shape] ?? `<rect x="2" y="2" width="20" height="20" rx="3" fill="currentColor" stroke="none"/><text x="12" y="16" text-anchor="middle" fill="#182026" stroke="none" font-family="Arial,sans-serif" font-size="${shape.length > 2 ? 8 : 11}" font-weight="700">${shape}</text>`;
  return `<svg class="file-type-icon" data-file-kind="${kind}" viewBox="0 0 24 24" style="color:${color}" aria-hidden="true" focusable="false">${contents}</svg>`;
}
export function folderIconMarkup() {
  return `<svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes.folder}</svg>`;
}
