import { appearance, setAppearance, type Appearance } from './appearance';
import { editName } from './inline-name';
import { ExplorerSelection } from './explorer-selection';
import { showContextMenu } from './context-menu';
import { MediaPreview } from './media-preview';
import { ExplorerDrag } from './explorer-drag';
import { movedPath } from './explorer-transfer.mjs';
import { DatabaseView } from './database-view';
import { QuickAccess, type QuickItem } from './quick-access';
import { resizePanel } from './panel-layout';
import { fileIconMarkup, fileIconFor, folderIconMarkup } from './file-icons.mjs';
import { DocumentPreview } from './document-preview';
import { resolveDocumentLink } from './document-renderer.mjs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { CodeEditor } from './editor';
import { TerminalManager } from './terminals';
import { escapeHtml as html, parseContainers } from './utils.mjs';
import type { Database, FileEntry, Page, Project, ToolStatus } from './types';
import './style.css';
import './workbench.css';

const icons: Record<string, string> = {
  projects: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 8-12 2-12 8"/>',
  docker: '<path d="M3 12h16c2 0 3-2 3-2 0 8-4 11-10 11S2 18 2 14"/><path d="M5 12V8h4v4m0-4V4h4v8m0-4h4v4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-3-15-4 18"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 4M4 15l3 4a7 7 0 0 0 12-3"/>',
  collapse: '<path d="m8 9 4-4 4 4m-8 6 4 4 4-4"/>',
  save: '<path d="m5 12 4 4L19 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
function icon(name: string) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.code}</svg>`; }
function element<T extends HTMLElement>(selector: string) { const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing element: ${selector}`); return node; }
const app = element<HTMLDivElement>('#app');
app.insertAdjacentHTML('beforebegin', `<header class="window-bar" aria-label="Application title bar"><img src="/aurea-mark.svg" alt="" aria-hidden="true"><nav aria-label="Application menu"><button data-menu="file" aria-haspopup="menu">File</button><button data-menu="edit" aria-haspopup="menu">Edit</button><button data-menu="view" aria-haspopup="menu">View</button></nav><div class="window-drag" data-tauri-drag-region>Aurea Code</div><div class="window-controls"><button id="window-minimize" aria-label="Minimize" title="Minimize">−</button><button id="window-maximize" aria-label="Maximize" title="Maximize">□</button><button id="window-close" aria-label="Close window" title="Close window">×</button></div></header>`);
app.innerHTML = `

  <aside class="sidebar">
    <div class="brand"><img class="brand-mark" src="/aurea-mark.svg" alt="" aria-hidden="true"><span>Aurea<span class="brand-light"> Code</span></span></div>
    <div class="workspace-label">WORKSPACE <button id="new-workspace" class="icon-button" title="New workspace" aria-label="New workspace">+</button></div>
    <select id="workspace-select" aria-label="Active workspace"></select>
    <nav aria-label="Main navigation">
      <button data-page="projects">${icon('projects')} Projects <span id="project-count" class="count">0</span></button>

    </nav>
    <div class="sidebar-projects"><div class="nav-label">IN THIS WORKSPACE</div><div id="project-shortcuts"></div></div>
    <div class="sidebar-bottom"><button data-page="settings">${icon('settings')} Environment</button><div class="local-indicator"><span class="dot"></span> Local by design <span>↗</span></div></div>
  </aside>
  <div class="main-shell">
    <header id="ide-header" hidden><button id="back-launcher" class="small-button">← Projects</button><div><strong id="ide-project-name"></strong><small id="ide-project-path"></small></div><button id="quick-open" class="quick-trigger">${icon('search')} <span>Search files</span><kbd>Ctrl P</kbd></button><div id="ide-actions"><button id="start-shell" class="small-button">Terminal</button></div></header>
    <nav id="ide-navigation" hidden aria-label="Project tools"><button data-page="editor" title="Editor" aria-label="Editor">${icon('code')}<span>Editor</span></button><button data-page="git" title="Source control" aria-label="Source control">${icon('git')}<span>Git</span></button><button data-page="docker" title="Docker Compose" aria-label="Docker Compose">${icon('docker')}<span>Docker</span></button><button data-page="database" title="Databases" aria-label="Databases">${icon('database')}<span>Data</span></button><button id="commands" title="Command palette (Ctrl Shift P)" aria-label="Command palette">${icon('search')}<span>Actions</span></button><button id="toggle-explorer" title="Toggle explorer (Ctrl B)" aria-label="Toggle explorer" aria-pressed="true">${icon('folder')}<span>Project</span></button><button id="ide-reveal" title="Reveal project folder" aria-label="Reveal project folder">${icon('folder')}<span>Folder</span></button></nav>
    <header class="topbar"><div class="breadcrumb"><span id="workspace-name">Personal</span><span>/</span><strong id="page-name">Projects</strong></div><div class="top-actions"><span class="shortcut">Ctrl + O</span><button id="open-top" class="small-button">${icon('folder')} Open project</button></div></header>
    <div id="preview-banner" hidden>Interface preview. Open the desktop app to use files, Git, and Docker.</div>
    <main id="content"><section id="database-page" hidden aria-label="Database workspace"></section><section id="page-content"></section><section id="editor-page" hidden><aside class="file-sidebar"><div class="section-heading"><span>PROJECT</span><button id="collapse-folders" class="icon-button" title="Collapse folders" aria-label="Collapse folders">−</button><button id="new-folder" class="icon-button" title="New folder" aria-label="New folder">▣</button><button id="new-file" class="icon-button" title="New file" aria-label="New file">+</button><button id="refresh-files" class="icon-button" title="Refresh files">↻</button></div><div id="explorer-root"></div><div id="file-tree"></div><div id="explorer-resize" class="resize-handle" aria-label="Explorer width"></div></aside><div class="editor-groups"><div class="editor-area editor-group" data-group="0"><div id="editor-tabs" role="tablist" aria-label="Open files" hidden></div><div class="editor-toolbar"><span id="editor-title">Select a file</span><div><span id="document-modes" hidden role="group" aria-label="Document view"><button data-document-mode="code" aria-pressed="true">Code</button><button data-document-mode="split" aria-pressed="false">Split</button><button data-document-mode="preview" aria-pressed="false">Preview</button></span><button id="split-editor" class="small-button" title="Split editor right (Ctrl+\\)">Split Right</button><button id="reload-file" class="small-button">Reopen</button><button id="save-file" class="small-button">Save</button></div></div><div id="editor-empty" class="editor-empty">${icon('code')}<h2>Your workspace, ready.</h2><p>Choose a file to start editing.</p><div class="welcome-actions"><button id="empty-search">Go to file <kbd>Ctrl P</kbd></button><button id="empty-commands">All commands <kbd>Ctrl Shift P</kbd></button><button id="empty-terminal">Open terminal <kbd>Ctrl &#96;</kbd></button></div></div><div class="document-workspace"><div id="code-editor"></div><div id="media-preview" class="media-preview" hidden></div><article id="document-preview" class="document-preview" aria-label="Document preview" hidden></article></div></div><div id="group-resize" class="resize-handle" aria-label="Editor group width" hidden></div><div class="editor-area editor-group" data-group="1" hidden><div id="editor-tabs-secondary" role="tablist" aria-label="Open files, second group"></div><div class="editor-toolbar"><span id="editor-title-secondary">Select a file</span><div><span id="document-modes-secondary" hidden role="group" aria-label="Document view"><button data-document-mode="code">Code</button><button data-document-mode="split">Split</button><button data-document-mode="preview">Preview</button></span><button id="save-secondary" class="small-button">Save</button><button id="close-group" class="small-button">Close Group</button></div></div><div class="document-workspace"><div id="code-editor-secondary"></div><div id="media-preview-secondary" class="media-preview" hidden></div><article id="document-preview-secondary" class="document-preview" hidden></article></div></div></div></section></main>
    <section id="terminal-panel" hidden><div id="terminal-resize" class="resize-handle" aria-label="Terminal height"></div><div class="terminal-toolbar"><span class="panel-label">TERMINAL</span><div id="terminal-tabs"></div><button id="new-terminal" class="icon-button" title="New terminal" aria-label="New terminal">+</button><button id="hide-terminal" class="icon-button" aria-label="Hide terminal" title="Hide terminal">−</button><button id="close-terminal" class="icon-button" aria-label="Close terminal" title="Close terminal">×</button></div><div id="terminal-content"></div></section>
    <footer class="statusbar"><span><span class="dot"></span> <span id="status-text">Aurea Code</span></span><span id="cursor-position"></span><span id="status-file">UTF-8 <span class="status-separator">·</span> Rust + Tauri</span><button id="show-terminal">${icon('terminal')} Terminal</button></footer>
  </div><div id="toast" role="status" aria-live="polite" hidden><span id="toast-message"></span><button id="toast-close" aria-label="Dismiss notification">×</button></div><dialog id="modal"></dialog><dialog id="discard-modal" aria-labelledby="discard-title"><form method="dialog"><h2 id="discard-title">Unsaved changes</h2><p id="discard-message"></p><div class="modal-actions"><button id="discard-cancel" class="small-button" value="cancel" autofocus>Cancel</button><button id="discard-confirm" class="primary-button" value="discard">Discard changes</button></div></form></dialog>`;

// Keep navigation and global tools in one toolbar; the explorer is for files.
const ideHeader = element('#ide-header');
ideHeader.insertBefore(element('#ide-navigation'), element('#quick-open'));
ideHeader.insertBefore(element('#toggle-explorer'), element('#back-launcher'));
element('#commands').hidden = true; element('#ide-reveal').hidden = true;
for (const [id, glyph, title] of [
  ['toggle-explorer', 'sidebar', 'Show or hide files (Ctrl B)'], ['back-launcher', 'back', 'All projects'],
  ['start-shell', 'terminal', 'Show or hide terminal (Ctrl `)'], ['split-editor', 'split', 'Split editor right (Ctrl \\)'],
  ['save-file', 'save', 'Save file (Ctrl S)'], ['save-secondary', 'save', 'Save file (Ctrl S)'],
  ['reload-file', 'refresh', 'Reload from disk'], ['close-group', 'sidebar', 'Merge editor groups'],
  ['new-file', 'plus', 'New file'], ['new-folder', 'folder', 'New folder'],
  ['refresh-files', 'refresh', 'Refresh files'], ['collapse-folders', 'collapse', 'Collapse folders'],
]) {
  const button = element(`#${id}`); button.innerHTML = icon(glyph); button.title = title; button.setAttribute('aria-label', title); button.classList.add('toolbar-icon');
}
const moreButton = document.createElement('button'); moreButton.id = 'workspace-more'; moreButton.className = 'toolbar-icon'; moreButton.innerHTML = icon('more'); moreButton.title = 'Workspace actions'; moreButton.setAttribute('aria-label', 'Workspace actions'); moreButton.setAttribute('aria-haspopup', 'menu'); element('#ide-actions').append(moreButton);
const themeButton = document.createElement('button'); themeButton.id = 'appearance-button'; themeButton.className = 'toolbar-icon'; themeButton.innerHTML = icon('sun'); themeButton.title = 'Appearance'; themeButton.setAttribute('aria-label', 'Appearance'); themeButton.setAttribute('aria-haspopup', 'menu'); element('.window-bar').insertBefore(themeButton, element('.window-controls'));
element('.section-heading > span').textContent = 'Files';
for (const [page, label] of [['editor', 'Code'], ['git', 'Changes'], ['docker', 'Services'], ['database', 'Data']]) element(`#ide-navigation [data-page="${page}"] span`).textContent = label;
element('#editor-empty').innerHTML = `<div class="empty-symbol">${icon('code')}</div><h2>Your workspace.</h2><p>Choose a file, or find it with a quick search.</p><div class="welcome-actions"><button id="empty-search">Find a file <kbd>Ctrl P</kbd></button><button id="empty-commands">Browse actions <kbd>Ctrl Shift P</kbd></button><button id="empty-terminal">Open terminal <kbd>Ctrl &#96;</kbd></button></div>`;

let db: Database = { version: 1, workspaces: [{ id: 'preview', name: 'Personal' }], projects: [] };
let tools: ToolStatus[] = [];
let workspaceId = localStorage.getItem('aurea.workspace') ?? '';
let projectId = '';
let page: Page = 'projects';
let stage: 'launcher' | 'ide' = 'launcher';
app.dataset.stage = stage;
let pageRevision = 0;
let toastTimer = 0;
let trayReady = false;
let treeRevision = 0;
const content = element<HTMLElement>('#page-content');
const editor = new CodeEditor(element('#code-editor'), updateEditorTitle, notify, updateCursorPosition, element('#code-editor-secondary'));
const documentPreview = new DocumentPreview(element('#document-preview'), element('#code-editor'), element('#document-modes'), () => editor.view?.requestMeasure());
const secondaryDocumentPreview = new DocumentPreview(element('#document-preview-secondary'), element('#code-editor-secondary'), element('#document-modes-secondary'), () => editor.groups[1].view?.requestMeasure());
const mediaPreviews = [new MediaPreview(element('#media-preview')), new MediaPreview(element('#media-preview-secondary'))];
const terminals = new TerminalManager(element('#terminal-panel'), element('#terminal-tabs'), element('#terminal-content'), notify);
const databaseView = new DatabaseView(element('#database-page'), notify, request => terminals.start(project(), 'database-tool', request));
function notify(message: string) { const toast = element('#toast'); element('#toast-message').textContent = message; toast.hidden = false; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; }, 9000); }
element('#toast-close').onclick = () => { element('#toast').hidden = true; window.clearTimeout(toastTimer); };
function desktop() { if (!isTauri()) throw new Error('This feature is available in the desktop app.'); }
function workspace() { return db.workspaces.find(w => w.id === workspaceId) ?? db.workspaces[0]; }
function projects() { return db.projects.filter(p => p.workspace_id === workspace().id); }
function project() { const value = db.projects.find(p => p.id === projectId); if (!value) throw new Error('Open a project first.'); return value; }
async function perform(action: () => Promise<unknown>) { try { await action(); } catch (error) { notify(String(error)); } }
function bind(selector: string, action: (button: HTMLButtonElement) => Promise<unknown> | unknown) {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach(button => { button.onclick = () => { button.disabled = true; void perform(async () => { try { await action(button); } finally { button.disabled = false; updateEditorTitle(); } }); }; });
}
async function confirmAction(message: string) { desktop(); return confirm(message, { title: 'Aurea Code', kind: 'warning', okLabel: 'Continue', cancelLabel: 'Cancel' }); }
function confirmDiscard(message: string): Promise<boolean> {
  const modal = element<HTMLDialogElement>('#discard-modal');
  if (modal.open) return Promise.resolve(false);
  element('#discard-message').textContent = message;
  modal.returnValue = 'cancel';
  return new Promise(resolve => {
    modal.onclose = () => { modal.onclose = null; resolve(modal.returnValue === 'discard'); };
    modal.showModal();
  });
}
async function canDiscard(all = true) { return !(all ? editor.hasUnsavedChanges || databaseView.dirty : editor.dirty) || confirmDiscard('You have unsaved changes in files, SQL console or the database grid. Discard them?'); }
function refreshSidebar() {
  const active = workspace(); workspaceId = active.id; localStorage.setItem('aurea.workspace', workspaceId);
  element<HTMLSelectElement>('#workspace-select').innerHTML = db.workspaces.map(w => `<option value="${html(w.id)}" ${w.id === active.id ? 'selected' : ''}>${html(w.name)}</option>`).join('');
  element('#workspace-name').textContent = active.name; element('#project-count').textContent = String(projects().length);
  element('#project-shortcuts').innerHTML = projects().map(p => `<button class="project-shortcut ${p.id === projectId ? 'selected' : ''}" data-project="${html(p.id)}">${icon('folder')}<span>${html(p.name)}</span></button>`).join('') || '<p class="sidebar-hint">Your projects appear here.</p>';
  bind('[data-project]', button => openProject(button.dataset.project!));
  document.querySelectorAll('[data-page]').forEach(node => { const active = (node as HTMLElement).dataset.page === page; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
}
async function navigate(next: Page) {
  if (['editor', 'git', 'docker', 'database'].includes(next) && !projectId) { notify('Open a project to use its tools.'); return; }
  if (['projects', 'settings'].includes(next) && projectId) {
    if (databaseView.busy) { notify('Finish or cancel the database operation before leaving the project.'); return; }
    if (!await canDiscard()) return;
    if (terminals.running && !await confirmAction('Returning to the launcher will close this project\'s terminals. Continue?')) return;
    await terminals.closeAll(); editor.close(); databaseView.reset(); projectId = ''; treeRevision++;
  }
  stage = projectId ? 'ide' : 'launcher'; app.dataset.stage = stage;
  element('#ide-header').hidden = stage !== 'ide'; element('#ide-navigation').hidden = stage !== 'ide';
  if (stage === 'ide') { element('#ide-project-name').textContent = project().name; element('#ide-project-path').textContent = project().path; }
  page = next; pageRevision++; refreshSidebar();
    const names = { projects: 'Projects', editor: projectId ? project().name : 'Editor', git: 'Source control', docker: 'Docker', database: 'Databases', settings: 'Environment' };
    element('#page-name').textContent = names[page];
    element('#editor-page').hidden = stage !== 'ide' || page === 'database'; content.hidden = page === 'editor' || page === 'database';
    element('#database-page').hidden = page !== 'database';
    app.dataset.tool = page;
    element('#explorer-root').textContent = projectId ? project().name : '';
    element('#ide-project-name').title = projectId ? project().path : '';
    if (page === 'editor') content.replaceChildren();
    if (page === 'projects') renderProjects();
    else if (page === 'git') await renderGit();
    else if (page === 'docker') await renderDocker();
    else if (page === 'database') await databaseView.activate(project());
    else if (page === 'settings') await renderSettings();
    editor.view?.requestMeasure();
}
function heading(eyebrow: string, title: string, description: string, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}${stage === 'ide' ? '<button id="close-tool" class="icon-button" aria-label="Close tool panel" title="Close tool panel">×</button>' : ''}</div>`; }
function renderProjects() {
  const list = projects();
  content.innerHTML = heading('WELCOME TO AUREA CODE', 'Projects', 'Choose where to continue working.', `<button id="add-project" class="primary-button">${icon('folder')} Open folder</button>`) + `
    <div class="list-heading"><h2>In this workspace</h2><label class="search-field">${icon('search')}<input id="project-search" placeholder="Search projects…" aria-label="Search projects"></label></div>
    <div id="project-grid" class="project-grid">${list.map(p => `<article class="project-card" data-project-card="${html(p.id)}" data-card-name="${html((p.name + ' ' + p.path).toLowerCase())}"><span class="folder-tile">${icon('folder')}</span><div><button class="project-title" data-project="${html(p.id)}">${html(p.name)}</button><p class="project-path" title="${html(p.path)}">${html(p.path)}</p></div><span class="project-chevron" aria-hidden="true">${icon('arrow')}</span></article>`).join('') || '<div class="empty-state"><h2>Your next project starts here.</h2><p>Open a folder on your computer to enter the IDE.</p></div>'}</div>
    `;
  bind('#add-project, #add-project-card', addProject); bind('[data-project]', b => openProject(b.dataset.project!));
  document.querySelectorAll<HTMLElement>('[data-project-card]').forEach(card => { card.onclick = event => { if (!(event.target as HTMLElement).closest('button')) void perform(() => openProject(card.dataset.projectCard!)); }; });
  element<HTMLInputElement>('#project-search').oninput = event => { const query = (event.target as HTMLInputElement).value.toLowerCase(); document.querySelectorAll<HTMLElement>('[data-card-name]').forEach(card => { card.hidden = !card.dataset.cardName!.includes(query); }); };
}
async function addProject() {
  desktop(); if (projectId) { await navigate('projects'); if (projectId) return; }
  const path = await open({ directory: true, multiple: false, title: 'Select or create the project folder' }); if (!path) return;
  db = await invoke<Database>('add_project', { workspaceId, path }); const added = db.projects.find(p => p.path === path && p.workspace_id === workspaceId) ?? db.projects.at(-1)!; await openProject(added.id);
}
async function openProject(id: string) {
  desktop();
  if (id !== projectId && projectId) { await navigate('projects'); if (projectId) return; }
  terminals.activate(id);
  if (id !== projectId) editor.close(); projectId = id;
  await navigate('editor'); await renderTree();
}
async function transferEntries(entries: FileEntry[], destination: string, copy: boolean) {
  const id = projectId;
  let completed = 0;
  try {
    for (const entry of entries) {
      const transferredPath = await editor.transfer(id, entry.path, destination, copy);
      completed++;
      if (!copy && id === projectId) remapExplorer(entry.path, transferredPath);
    }
    notify(`${completed} item(s) ${copy ? 'copied (saved disk contents)' : 'moved'}.`);
  } catch (error) {
    throw new Error(`${completed} of ${entries.length} item(s) completed. ${String(error)}`);
  } finally {
    if (id === projectId) { if (destination) expandedFolders.add(destination); await renderTree(); }
  }
}
function remapExplorer(source: string, destination: string) {
  for (const path of [...expandedFolders]) { expandedFolders.delete(path); expandedFolders.add(movedPath(path, source, destination)); }
  explorerSelection.remap(source, destination);
}
function renameEntry(entry: FileEntry) {
  const id = projectId;
  editName(element('#file-tree'), entry.name, `Rename ${entry.name}`, async name => {
    const path = await editor.rename(id, entry.path, name);
    if (id === projectId) { remapExplorer(entry.path, path); await renderTree(); }
  }, !entry.directory);
}
function createEntry(parent: string, folder: boolean) {
  const id = projectId;
  editName(element('#file-tree'), '', `${folder ? 'New folder' : 'New file'} in ${parent || project().name}`, async name => {
    if (!name || /[\\/]/.test(name)) throw new Error('Enter a single name.');
    const path = parent ? `${parent}/${name}` : name;
    if (folder) await invoke('create_folder', { projectId: id, parent, name }); else await invoke('create_file', { projectId: id, relative: path });
    if (id === projectId) { if (parent) expandedFolders.add(parent); await renderTree(); if (!folder) await editor.open(id, path, true); }
  });
}
const explorerSelection = new ExplorerSelection(element('.file-sidebar'), {
  transfer: transferEntries, rename: renameEntry, create: createEntry, report: notify,
  open: (entry, side) => void perform(() => editor.open(projectId, entry.path, true, false, side ? 1 : editor.activeGroup)),
});
const explorerDrag = new ExplorerDrag((entries, destination, copy) => perform(() => transferEntries(entries, destination, copy)), entry => explorerSelection.forDrag(entry));
const expandedFolders = new Set<string>();
let treeProjectId = '';
async function renderTree() {
  explorerDrag.reset(); explorerSelection.activate(projectId);
  if (treeProjectId !== projectId) { expandedFolders.clear(); treeProjectId = projectId; }
  explorerDrag.attachTarget(element('#explorer-root'), '');
  element('#explorer-root').title = 'Drop here to move to project root. Hold Ctrl (Option on macOS) to copy.';
  const revision = ++treeRevision; const id = projectId; const tree = element('#file-tree'); tree.replaceChildren(); explorerDrag.attachTarget(tree, '');
  async function load(relative: string, parent: HTMLElement) {
    const entries = await invoke<FileEntry[]>('list_files', { projectId: id, relative }); if (id !== projectId || revision !== treeRevision) return;
    for (const entry of entries) {
      if (entry.directory) {
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.innerHTML = folderIconMarkup(); const label = document.createElement('span'); label.textContent = entry.name; summary.append(label); summary.title = entry.path; details.append(summary); parent.append(details);
        explorerSelection.attach(summary, entry); summary.onclick = event => { if (!explorerSelection.click(event, entry)) event.preventDefault(); };
        explorerDrag.attachSource(summary, entry); explorerDrag.attachTarget(summary, entry.path, () => { details.open = true; });
        let loaded = false;
        details.ontoggle = () => { summary.setAttribute('aria-expanded', String(details.open)); if (details.open) expandedFolders.add(entry.path); else expandedFolders.delete(entry.path); if (details.open && !loaded) { loaded = true; const children = document.createElement('div'); children.className = 'tree-children'; explorerDrag.attachTarget(children, entry.path); details.append(children); void load(entry.path, children).catch(e => { loaded = false; children.remove(); notify(String(e)); }); } };
        details.open = expandedFolders.has(entry.path); summary.setAttribute('aria-expanded', String(details.open));
      } else {
        const button = document.createElement('button'); button.className = 'file-button'; button.innerHTML = fileIconMarkup(entry.path); const label = document.createElement('span'); label.className = 'file-label'; label.textContent = entry.name; button.append(label); button.title = entry.path; button.setAttribute('aria-label', `${entry.name} (${fileIconFor(entry.path).label})`);
        explorerSelection.attach(button, entry); explorerDrag.attachSource(button, entry); explorerDrag.attachTarget(button, relative);
        button.onclick = event => { if (explorerSelection.click(event, entry)) void perform(async () => { await editor.open(id, entry.path); button.focus(); }); };
        button.ondblclick = () => void perform(() => editor.open(id, entry.path, true)); parent.append(button);
      }
    }
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted tree-empty'; empty.textContent = 'Empty folder'; parent.append(empty); }
  }
  await load('', tree);
}
let draggedTab: { id: number; group: number } | undefined;
function renderEditorTabs() {
  for (const [groupIndex, group] of editor.groups.entries()) {
    const host = element(groupIndex ? '#editor-tabs-secondary' : '#editor-tabs');
    host.hidden = group.tabs.length === 0;
    for (const node of Array.from(host.children)) if (!group.tabs.some(tab => String(tab.id) === (node as HTMLElement).dataset.tabId)) node.remove();
    const drop = (event: DragEvent, before?: typeof editor.file) => {
      if (!draggedTab) return; event.preventDefault(); event.stopPropagation();
      const tab = editor.tabs.find(tab => tab.id === draggedTab!.id);
      if (tab) editor.reorder(tab, draggedTab.group, groupIndex, before);
      draggedTab = undefined;
    };
    host.ondragover = event => { if (draggedTab) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; } };
    host.ondrop = event => drop(event);
    for (const [index, tab] of group.tabs.entries()) {
      let node = Array.from(host.children).find(child => (child as HTMLElement).dataset.tabId === String(tab.id)) as HTMLElement | undefined;
      if (!node) {
        node = document.createElement('div'); node.className = 'editor-tab'; node.dataset.tabId = String(tab.id); node.draggable = true;
        node.ondragstart = event => { draggedTab = { id: tab.id, group: groupIndex }; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-aurea-tab', String(tab.id)); } };
        node.ondragend = () => { draggedTab = undefined; };
        node.ondragover = event => { if (draggedTab) event.preventDefault(); };
        node.ondrop = event => drop(event, tab);
        const select = document.createElement('button'); select.className = 'editor-tab-select'; select.setAttribute('role', 'tab');
        select.innerHTML = '<span class="tab-icon"></span><span class="tab-file-name"></span><span class="tab-dirty" aria-hidden="true">●</span>';
        select.onclick = () => void perform(() => editor.open(tab.projectId, tab.path, false, false, groupIndex));
        select.ondblclick = () => editor.pin(tab);
        select.onkeydown = event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = group.tabs.indexOf(tab);
          if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            const next = event.key === 'ArrowLeft' ? index - 1 : index + 2;
            if (next >= 0) editor.reorder(tab, groupIndex, groupIndex, group.tabs[next]);
          } else {
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + group.tabs.length) % group.tabs.length;
            const target = group.tabs[next];
            void perform(async () => { await editor.open(target.projectId, target.path, false, false, groupIndex); host.querySelector<HTMLButtonElement>(`[data-tab-id="${target.id}"] .editor-tab-select`)?.focus(); });
          }
        };
        const closeTab = () => void perform(async () => {
          const last = editor.groups.filter(value => value.tabs.includes(tab)).length === 1;
          if (last && editor.isDirty(tab) && !await confirmDiscard(`Close ${tab.path} and discard its unsaved changes?`)) return;
          editor.closeTab(tab, groupIndex);
        });
        const close = document.createElement('button'); close.className = 'editor-tab-close'; close.textContent = '×'; close.onclick = closeTab;
        node.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeTab(); } };
        node.oncontextmenu = event => { event.preventDefault(); showContextMenu(event.clientX, event.clientY, [
          { label: 'Split Right', shortcut: 'Ctrl+\\', run: () => editor.split(tab) },
          { label: groupIndex ? 'Move to Left Group' : 'Move to Right Group', run: () => editor.reorder(tab, groupIndex, 1 - groupIndex) },
          { label: 'Keep Open', run: () => editor.pin(tab) },
          { label: 'Close', shortcut: 'Ctrl+W', run: closeTab },
        ], select); };
        node.append(select, close); host.append(node);
      }
      if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
      const active = group.active === tab; node.classList.toggle('active', active); node.classList.toggle('temporary', !tab.pinned);
      const select = node.querySelector<HTMLButtonElement>('.editor-tab-select')!;
      select.querySelector('.tab-icon')!.innerHTML = fileIconMarkup(tab.path);
      select.querySelector('.tab-file-name')!.textContent = tab.path.split(/[\\/]/).pop()!;
      select.querySelector<HTMLElement>('.tab-dirty')!.hidden = !editor.isDirty(tab);
      select.setAttribute('aria-label', `${tab.path}${editor.isDirty(tab) ? ' — Unsaved changes' : ''}`);
      select.title = tab.path; select.setAttribute('aria-selected', String(active)); select.tabIndex = active ? 0 : -1;
      node.querySelector('.editor-tab-close')!.setAttribute('aria-label', `Close ${tab.path}`);
    }
  }
}
function updateCursorPosition() {
  const selection = editor.view?.state.selection.main;
  const line = selection && editor.view?.state.doc.lineAt(selection.head);
  element('#cursor-position').textContent = line && selection ? `Ln ${line.number}, Col ${selection.head - line.from + 1}` : '';
}
function updateEditorTitle() {
  renderEditorTabs();
  const previews = [documentPreview, secondaryDocumentPreview];
  for (const [index, group] of editor.groups.entries()) {
    const suffix = index ? '-secondary' : ''; const file = group.active;
    const groupHost = element(`[data-group="${index}"]`);
    groupHost.classList.toggle('focused-group', editor.activeGroup === index);
    if (index) groupHost.hidden = !group.tabs.length;
    const source = file?.state.doc.toString() ?? '';
    previews[index].update(file && !file.media ? `${file.projectId}/${file.path}` : '', source);
    mediaPreviews[index].update(file);
    const code = element(`#code-editor${suffix}`);
    if (file?.media) {
      const svg = file.media === 'image/svg+xml'; code.hidden = !svg;
      element(`#document-modes${suffix}`).hidden = true;
    }
    element(`#editor-title${suffix}`).textContent = file ? `${editor.isDirty(file) ? '● ' : ''}${file.path}` : 'Select a file';
    groupHost.querySelector<HTMLElement>('.document-workspace')!.hidden = !file;
  }
  element('.editor-groups').classList.toggle('has-split', editor.groups[1].tabs.length > 0);
  element('#group-resize').hidden = editor.groups[1].tabs.length === 0;
  updateCursorPosition();
  const saveState = !editor.file ? 'Ready' : editor.file.conflicted ? 'File changed on disk' : editor.hasUnsavedChanges ? 'Unsaved changes' : editor.isBinary(editor.file) ? 'Preview' : 'All changes saved';
  if (element('#status-text').textContent !== saveState) element('#status-text').textContent = saveState;
  element('#status-file').textContent = editor.file ? `${editor.isBinary(editor.file) ? 'Preview' : 'UTF-8'} · ${editor.languageName}` : 'UTF-8 · Rust + Tauri';
  element('#editor-empty').hidden = !!editor.groups[0].active;
  element<HTMLButtonElement>('#save-file').disabled = !editor.groups[0].active || !editor.isDirty(editor.groups[0].active);
  element<HTMLButtonElement>('#save-secondary').disabled = !editor.groups[1].active || !editor.isDirty(editor.groups[1].active);
  element<HTMLButtonElement>('#reload-file').disabled = !editor.groups[0].active;
}
function formDialog(title: string, fields: string, submit: (data: FormData) => Promise<void>) {
  const modal = element<HTMLDialogElement>('#modal');
  modal.innerHTML = `<form id="modal-form"><div class="modal-heading"><h2>${title}</h2><button type="button" id="modal-close" class="icon-button" aria-label="Close">×</button></div>${fields}<p id="modal-error" role="alert"></p><div class="modal-actions"><button type="button" id="modal-cancel" class="small-button">Cancel</button><button type="submit" class="primary-button">Create</button></div></form>`;
  bind('#modal-close, #modal-cancel', () => modal.close());
  element<HTMLFormElement>('#modal-form').onsubmit = event => { event.preventDefault(); const button = modal.querySelector<HTMLButtonElement>('[type="submit"]')!; button.disabled = true;
    void submit(new FormData(event.target as HTMLFormElement)).then(() => modal.close()).catch(error => { element('#modal-error').textContent = String(error); }).finally(() => { button.disabled = false; }); };
  modal.showModal(); modal.querySelector<HTMLInputElement>('input')?.focus();
}
function newWorkspace() { desktop(); formDialog('New workspace', '<label>Name<input name="title" placeholder="e.g. Work" maxlength="80" required autocomplete="off"></label><p class="muted">Group your local projects in a workspace.</p>', async data => { if (!await canDiscard()) return; db = await invoke('create_workspace', { title: data.get('title') }); workspaceId = db.workspaces.at(-1)!.id; projectId = ''; editor.close(); await navigate('projects'); }); }
async function renderGit() {
  const current = project(); const revision = pageRevision;
  content.innerHTML = heading('SOURCE CONTROL', html(current.name), 'Review changes and create commits without leaving your project.', '<button id="git-refresh" class="small-button">↻ Refresh</button>') + `<div class="git-layout"><div><h3>Repository status</h3><pre id="git-status" class="output">Loading…</pre><div class="button-row"><button id="git-stage" class="small-button">Stage all</button><button id="git-unstage" class="small-button">Unstage</button></div><label class="commit-label">Commit message<textarea id="commit-message" placeholder="feat: describe your change" rows="3" maxlength="4096"></textarea></label><button id="git-commit" class="primary-button">${icon('check')} Create commit</button><p class="muted small">Repository hooks are respected.</p></div><div><div class="tabs"><button data-git-view="diff" class="active">Changes</button><button data-git-view="staged">Staging</button><button data-git-view="log">History</button></div><pre id="git-output" class="output diff">Loading…</pre></div></div>`;
  async function load(action: string) { desktop(); return invoke<string>('git_action', { projectId: current.id, action }); }
  bind('#git-refresh', renderGit);
  bind('[data-git-view]', async b => { const output = await load(b.dataset.gitView!); if (revision !== pageRevision) return; element('#git-output').textContent = output || 'No changes.'; document.querySelectorAll('[data-git-view]').forEach(n => n.classList.toggle('active', n === b)); });
  bind('#git-stage, #git-unstage', async b => { if (!await confirmAction(b.id === 'git-stage' ? 'Stage all changes in this project? Review the diff before committing.' : 'Unstage changes while keeping the files on disk?')) return; await load(b.id === 'git-stage' ? 'stage' : 'unstage'); if (revision === pageRevision) await renderGit(); });
  bind('#git-commit', async () => { const message = element<HTMLTextAreaElement>('#commit-message').value.trim(); if (!message) throw new Error('Enter a commit message.'); await invoke('git_action', { projectId: current.id, action: 'commit', message }); notify('Commit created.'); if (revision === pageRevision) await renderGit(); });
  try { const [status, diff] = await Promise.all([load('status'), load('diff')]); if (revision !== pageRevision) return; element('#git-status').textContent = status || 'No changes.'; element('#git-output').textContent = diff || 'No unstaged changes.'; }
  catch (error) { if (revision === pageRevision) { element('#git-status').textContent = String(error); element('#git-output').textContent = 'Open a project with an initialized Git repository.'; } }
}
async function renderDocker() {
  const current = project();
  const revision = pageRevision;
  content.innerHTML = heading('DEVELOPMENT ENVIRONMENT', html(current.name), 'Docker Compose containers associated with this project\'s folder.', `<div class="button-row"><button id="compose-up" class="small-button">Compose up + build</button><button id="docker-refresh" class="primary-button">↻ Refresh</button></div>`) + '<div id="docker-list" class="container-list"><p class="muted">Loading Docker…</p></div><pre id="docker-output" class="output" hidden></pre>';
  bind('#docker-refresh', renderDocker);
  bind('#compose-up', async () => { desktop(); const current = project(); if (!await confirmAction(`Build images and start Compose services in ${current.name}? This project\'s Compose file will be executed.`)) return; await terminals.start(current, 'compose'); });
  try {
    desktop(); const output = await invoke<string>('docker_action', { projectId: current.id, action: 'list' }); if (revision !== pageRevision) return;
    const containers = parseContainers(output);
    element('#docker-list').innerHTML = containers.map(c => `<article class="container-row"><span class="container-icon">${icon('docker')}</span><div class="container-name"><h3>${html(c.name)}</h3><p>${html(c.image)}</p><small>${html(c.ports)}</small></div><span class="badge ${c.state === 'running' ? 'running' : ''}">${html(c.status)}</span><div class="button-row"><button class="small-button" data-container="${html(c.id)}" data-docker-action="logs">Logs</button><button class="small-button" data-container="${html(c.id)}" data-docker-action="${c.state === 'running' ? 'stop' : 'start'}">${c.state === 'running' ? 'Stop' : 'Start'}</button><button class="small-button" data-container="${html(c.id)}" data-docker-action="restart">Restart</button></div></article>`).join('') || '<div class="empty-state"><h2>No containers here yet.</h2><p>Start this project\'s Compose services. Containers without the Compose working-directory label are not shown here.</p></div>';
    bind('[data-docker-action]', async b => { const action = b.dataset.dockerAction!; if (action !== 'logs' && !await confirmAction(`Run “${action}” on this project\'s container ${b.dataset.container!.slice(0, 12)}?`)) return; const result = await invoke<string>('docker_action', { projectId: current.id, action, container: b.dataset.container }); if (revision !== pageRevision) return; if (action === 'logs') { element('#docker-output').hidden = false; element('#docker-output').textContent = result || 'No logs.'; } else await renderDocker(); });
  } catch (error) { if (revision === pageRevision) { element('#docker-list').innerHTML = `<div class="empty-state"><h2>Docker unavailable</h2><p>${html(String(error))}</p><p>Install Docker, start the daemon, and check your context and user permissions.</p></div>`; } }
}
async function renderSettings() {
  const revision = pageRevision;
  if (isTauri()) tools = await invoke('tools_status');
  if (revision !== pageRevision) return;
  content.innerHTML = heading('DESKTOP INTEGRATION', 'Ready to work.', 'Aurea uses the tools installed on your system.') + `<div class="settings-card"><h2>Local tools</h2>${['git', 'docker'].map(name => { const tool = tools.find(t => t.name === name); return `<div class="tool-row"><div><strong>${name}</strong><p>${html(tool?.path ?? 'Install the native executable and add it to PATH.')}</p></div><span class="badge ${tool?.available ? 'running' : ''}">${tool?.available ? 'Found' : 'Not found'}</span></div>`; }).join('')}</div><div class="settings-grid"><div class="settings-card"><h2>Desktop integration</h2><p>Native menus, keyboard shortcuts, folder selection, and file manager integration.</p><p>${trayReady ? 'Closing the window keeps the app in the system tray. Use File → Quit to exit.' : 'The system tray is unavailable in this environment. Closing the window prompts you to quit.'}</p></div><div class="settings-card"><h2>Linux updates</h2><p>The release AppImage includes the GitHub update source for Gear Lever.</p><code>ItsAnunesS/aurea-code</code><p>Update checks and installation follow your Gear Lever preferences.</p></div></div><div class="info-box"><h3>Local tools and permissions</h3><p>Terminals, Git, and Docker run with your user permissions; only open projects you trust.</p></div>`;
}
async function quit() {
  if (databaseView.busy) { notify('Finish or cancel the database operation before quitting.'); return; }
  if ((editor.hasUnsavedChanges || databaseView.dirty) && !await confirmDiscard('Quit and discard unsaved changes in files, SQL console and database grid?')) return;
  if (terminals.running && !await confirmAction('Terminals are still running. Quitting will close them. Background services may keep running.')) return;
  await invoke('exit_app');
}
bind('[data-menu]', async button => {
  desktop();
  const bounds = button.getBoundingClientRect();
  await invoke('open_app_menu', { name: button.dataset.menu, x: bounds.left, y: bounds.bottom });
});
bind('#window-minimize', () => { desktop(); return getCurrentWindow().minimize(); });
bind('#window-maximize', () => { desktop(); return getCurrentWindow().toggleMaximize(); });
bind('#window-close', () => { desktop(); return getCurrentWindow().close(); });
async function updateWindowControls() {
  const maximized = await getCurrentWindow().isMaximized();
  const button = element<HTMLButtonElement>('#window-maximize');
  button.textContent = maximized ? '❐' : '□';
  button.title = maximized ? 'Restore' : 'Maximize';
  button.setAttribute('aria-label', button.title);
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => { button.onclick = () => { const next = button.dataset.page as Page; if (next !== page) void perform(() => navigate(next)); }; });
bind('#new-terminal, #empty-terminal', () => { desktop(); return terminals.start(project(), 'shell'); });
bind('#start-shell', () => { if (!element('#terminal-panel').hidden) terminals.hide(); else if (terminals.sessions.length) terminals.show(); else return terminals.start(project(), 'shell'); });
bind('#back-launcher', () => navigate('projects')); bind('#ide-reveal', () => invoke('reveal_project', { projectId }));
bind('#new-workspace', newWorkspace); bind('#open-top', addProject);
bind('#new-folder', () => createEntry(explorerSelection.currentFolder(), true));
bind('#new-file', () => createEntry(explorerSelection.currentFolder(), false));
for (const [index, selector] of ['#document-preview', '#document-preview-secondary'].entries()) element(selector).onclick = event => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-document-link]');
  const file = editor.groups[index].active;
  if (!link || !file) return;
  void perform(async () => {
    const target = resolveDocumentLink(file.path, link.dataset.documentLink!);
    if (target.external) { await invoke('open_document_link', { url: target.external }); return; }
    if (target.path) await editor.open(file.projectId, target.path, false, false, index);
  });
};
bind('#save-file', () => { editor.focusGroup(0); return editor.save(); }); bind('#reload-file', async () => { editor.focusGroup(0); if (editor.file && await canDiscard(false)) await editor.reload(); }); bind('#refresh-files', renderTree);
bind('#hide-terminal', () => terminals.hide()); bind('#close-terminal', async () => { if (await confirmAction('Close this terminal? The running process will be stopped.')) await terminals.closeSelected(); });
bind('#show-terminal', () => { desktop(); if (terminals.sessions.length) terminals.show(); else return terminals.start(project(), 'shell'); });
element<HTMLSelectElement>('#workspace-select').onchange = event => void perform(async () => { const next = (event.target as HTMLSelectElement).value; if (!await canDiscard()) { refreshSidebar(); return; } workspaceId = next; projectId = ''; editor.close(); await navigate('projects'); });
const quickAccess = new QuickAccess(notify);
function toggleExplorer() {
  const hidden = app.classList.toggle('explorer-hidden');
  element('#toggle-explorer').setAttribute('aria-pressed', String(!hidden));
  editor.view?.requestMeasure();
}
async function openQuickFiles() {
  if (!projectId) return;
  const id = projectId;
  await quickAccess.open('Search files by name or path…', async signal => {
    const items: QuickItem[] = [];
    const directories = [''];
    let visited = 0;
    while (directories.length && visited < 100 && items.length < 5000) {
      if (signal.aborted) return { items: [] };
      if (projectId !== id) throw new Error('The project changed. Open search again.');
      const entries = await invoke<FileEntry[]>('list_files', { projectId: id, relative: directories.shift()! });
      visited++;
      for (const entry of entries) {
        if (entry.directory) { if (directories.length < 5000) directories.push(entry.path); }
        else if (items.length < 5000) items.push({
          label: entry.name, detail: entry.path, path: entry.path,
          run: async () => { if (projectId !== id) return; if (page === 'database') await navigate('editor'); await editor.open(id, entry.path, true); }
        });
      }
    }
    return { items, note: directories.length || items.length >= 5000 ? 'Search limited to 100 folders / 5,000 files. Use the explorer for other files.' : `${items.length} files in this project · type to filter` };
  });
}
async function openCommands() {
  if (!projectId) return;
  const action = (label: string, detail: string, run: QuickItem['run']): QuickItem => ({ label, detail, run });
  await quickAccess.open('Type a command…', async () => ({ items: [
    action('Go to file', 'Ctrl P', openQuickFiles),
    action('Save current file', 'Ctrl S', () => editor.save()),
    action('New file', 'Project', () => element<HTMLButtonElement>('#new-file').click()),
    action('Split editor right', 'Ctrl+\\', () => editor.split()),
    action('Close secondary editor group', 'Editor', () => editor.closeGroup()),
    action('Toggle explorer', 'Ctrl B', toggleExplorer),
    action('New terminal', 'Project', () => terminals.start(project(), 'shell')),
    action('Source control', 'Git', () => navigate('git')),
    action('Database workspace', 'SQL and tables', () => navigate('database')),
    action('Docker Compose', 'Containers', () => navigate('docker')),
    action('Focus editor', 'Escape tool view', () => navigate('editor')),
    action('Return to projects', 'Launcher', () => navigate('projects')),
  ] }));
}
content.addEventListener('click', event => { if ((event.target as HTMLElement).closest('#close-tool')) void perform(() => navigate('editor')); });
bind('#appearance-button', button => {
  const rect = button.getBoundingClientRect();
  showContextMenu(rect.right - 220, rect.bottom + 6, (['system', 'light', 'dark'] as Appearance[]).map(value => ({
    label: value === 'system' ? 'Follow system' : value === 'light' ? 'Light' : 'Dark', checked: appearance() === value, run: () => setAppearance(value),
  })), button);
});
bind('#workspace-more', button => {
  const rect = button.getBoundingClientRect();
  showContextMenu(rect.right - 230, rect.bottom + 6, [
    { label: 'Browse all actions', shortcut: 'Ctrl Shift P', run: () => void perform(openCommands) },
    { label: 'New terminal', run: () => void perform(() => terminals.start(project(), 'shell')) },
    { label: 'Show project folder', run: () => void perform(() => invoke('reveal_project', { projectId })) },
    { label: 'Merge editor groups', disabled: !editor.groups[1].tabs.length, run: () => editor.closeGroup() },
    { label: 'All projects', run: () => void perform(() => navigate('projects')) },
  ], button);
});
new MutationObserver(() => element('#start-shell').setAttribute('aria-pressed', String(!element('#terminal-panel').hidden))).observe(element('#terminal-panel'), { attributes: true, attributeFilter: ['hidden'] });
bind('#quick-open, #empty-search', openQuickFiles);
bind('#commands, #empty-commands', openCommands);
bind('#toggle-explorer', toggleExplorer);
bind('#split-editor', () => editor.split());
bind('#close-group', () => editor.closeGroup());
bind('#save-secondary', () => { editor.focusGroup(1); return editor.save(); });
for (const [index] of editor.groups.entries()) {
  const host = element(`[data-group="${index}"]`);
  host.addEventListener('pointerdown', () => editor.focusGroup(index));
  host.addEventListener('dragover', event => { if (draggedTab) event.preventDefault(); });
  host.addEventListener('drop', event => {
    if (!draggedTab) return; event.preventDefault();
    const tab = editor.tabs.find(tab => tab.id === draggedTab!.id);
    if (tab) editor.reorder(tab, draggedTab.group, index); draggedTab = undefined;
  });
}

bind('#collapse-folders', () => document.querySelectorAll<HTMLDetailsElement>('#file-tree details').forEach(node => { node.open = false; }));
resizePanel(element('#group-resize'), element('.editor-groups'), '--primary-group-width', 'aurea.group-width', 500, 220, () => Math.max(220, (element('.editor-groups').clientWidth || innerWidth - 300) - 240), 'x');
resizePanel(element('#explorer-resize'), app, '--explorer-width', 'aurea.explorer-width', 240, 160, () => Math.min(480, window.innerWidth * .4), 'x');
resizePanel(element('#terminal-resize'), app, '--terminal-height', 'aurea.terminal-height', 240, 100, () => window.innerHeight * .65, 'y');
window.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
  const modified = event.ctrlKey || event.metaKey;
  // App shortcuts keep native-menu precedence over editor key bindings.
  if (modified && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === 'o') { event.preventDefault(); void perform(addProject); return; }
    if (key === 'q') { event.preventDefault(); void perform(quit); return; }
    if (key === 's') { event.preventDefault(); void perform(() => page === 'database' ? databaseView.saveSql() : editor.save()); return; }
    if (key === 'j' && projectId) { event.preventDefault(); void perform(() => terminals.start(project(), 'shell')); return; }
  }
  if (!projectId) return;
  if (modified) {
    if (event.key.toLowerCase() === 'p') { event.preventDefault(); void perform(event.shiftKey ? openCommands : openQuickFiles); }
    else if (event.key.toLowerCase() === 'b') { event.preventDefault(); toggleExplorer(); }
    else if (event.key === '\\') { event.preventDefault(); editor.split(); }
    else if (event.key === '1' || event.key === '2') { event.preventDefault(); const index = Number(event.key) - 1; if (editor.groups[index].active) { editor.focusGroup(index); editor.groups[index].view?.focus(); } }
    else if (event.key === '`') { event.preventDefault(); if (!element('#terminal-panel').hidden) terminals.hide(); else element<HTMLButtonElement>('#show-terminal').click(); }
    else if (event.key.toLowerCase() === 'w' && page !== 'database' && editor.file) {
      event.preventDefault(); element<HTMLButtonElement>(`[data-group="${editor.activeGroup}"] .editor-tab.active .editor-tab-close`).click();
    }
  }
}, { capture: true });
async function boot() {
  if (isTauri()) {
    await updateWindowControls();
    await getCurrentWindow().onResized(() => void perform(updateWindowControls));
    db = await invoke<Database>('load_workspace'); trayReady = await invoke('desktop_status');
    await listen<string>('native-action', event => void perform(async () => {
      const action = event.payload;
      if (action === 'open') await addProject(); else if (action === 'workspace') { await navigate('projects'); if (!projectId) newWorkspace(); } else if (action === 'save') { if (page === 'database') await databaseView.saveSql(); else await editor.save(); } else if (action === 'quit') await quit(); else if (action === 'terminal') await terminals.start(project(), 'shell'); else if (['projects', 'git', 'docker'].includes(action)) await navigate(action as Page);
    }));
    window.setInterval(() => { if (document.visibilityState === 'visible') void editor.sync(); }, 3000);
    window.addEventListener('focus', () => { void editor.sync(); });
  } else element('#preview-banner').hidden = false;
  element('#status-text').textContent = isTauri() ? 'Local environment' : 'Preview';
  updateEditorTitle(); refreshSidebar(); await navigate('projects');
}
void boot().catch(error => { app.dataset.stage = 'launcher'; content.innerHTML = `<div class="empty-state"><h2>Unable to open workspaces.</h2><p>${html(String(error))}</p><p>Existing data has not been overwritten.</p></div>`; });
