import MarkdownIt from 'markdown-it';
import { escapeHtml } from './utils.mjs';

export function documentKind(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(name)) return 'markdown';
  if (/\.(txt|text|rst|adoc|asciidoc)$/.test(name) || /^(readme|license|licence|copying|notice|authors|changelog|contributing)$/.test(name)) return 'text';
  return null;
}

const markdown = new MarkdownIt({ html: false, linkify: true, maxNesting: 30 });
// Links are handled by the app; document content never navigates the webview.
markdown.renderer.rules.link_open = (tokens, index) => `<button type="button" class="document-link" data-document-link="${escapeHtml(tokens[index].attrGet('href') ?? '')}">`;
markdown.renderer.rules.link_close = () => '</button>';
// Do not load arbitrary remote resources or expose unrestricted local file URLs.
markdown.renderer.rules.image = (tokens, index) => `<span class="document-image">[Image: ${escapeHtml(tokens[index].content || 'image')}]</span>`;

export function renderDocument(path, text) {
  return documentKind(path) === 'markdown' ? markdown.render(text) : `<pre class="document-text">${escapeHtml(text)}</pre>`;
}

export function resolveDocumentLink(currentPath, href) {
  if (!href || /[\u0000-\u001f\\]/.test(href)) throw new Error('Unsupported document link.');
  if (/^https?:\/\//i.test(href)) return { external: new URL(href).href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) throw new Error('Only project-relative and HTTP(S) links are supported.');
  const [path] = href.split(/[?#]/);
  if (!path) return { path: currentPath };
  const parts = currentPath.split('/').slice(0, -1);
  for (const part of decodeURIComponent(path).split('/')) {
    if (part === '..') { if (!parts.length) throw new Error('The link is outside this project.'); parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return { path: parts.join('/') };
}
