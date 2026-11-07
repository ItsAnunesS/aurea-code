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
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-3-15-4 18"/>',
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
    <nav id="ide-navigation" hidden aria-label="Project tools"><button data-page="editor" title="Editor" aria-label="Editor">${icon('code')}<span>Editor</span></button><button data-page="git" title="Source control" aria-label="Source control">${icon('git')}<span>Git</span></button><button data-page="docker" title="Docker Compose" aria-label="Docker Compose">${icon('docker')}<span>Docker</span></button><button id="commands" title="Command palette (Ctrl Shift P)" aria-label="Command palette">${icon('search')}<span>Actions</span></button><button id="toggle-explorer" title="Toggle explorer (Ctrl B)" aria-label="Toggle explorer" aria-pressed="true">${icon('folder')}<span>Project</span></button><button id="ide-reveal" title="Reveal project folder" aria-label="Reveal project folder">${icon('folder')}<span>Folder</span></button></nav>
    <header class="topbar"><div class="breadcrumb"><span id="workspace-name">Personal</span><span>/</span><strong id="page-name">Projects</strong></div><div class="top-actions"><span class="shortcut">Ctrl + O</span><button id="open-top" class="small-button">${icon('folder')} Open project</button></div></header>
    <div id="preview-banner" hidden>Interface preview. Open the desktop app to use files, Git, and Docker.</div>
    <main id="content"><section id="page-content"></section><section id="editor-page" hidden><aside class="file-sidebar"><div class="section-heading"><span>PROJECT</span><button id="collapse-folders" class="icon-button" title="Collapse folders" aria-label="Collapse folders">−</button><button id="new-file" class="icon-button" title="New file" aria-label="New file">+</button><button id="refresh-files" class="icon-button" title="Refresh files">↻</button></div><div id="explorer-root"></div><div id="file-tree"></div><div id="explorer-resize" class="resize-handle" aria-label="Explorer width"></div></aside><div class="editor-area"><div id="editor-tabs" role="tablist" aria-label="Open files" hidden></div><div class="editor-toolbar"><span id="editor-title">Select a file</span><div><span id="document-modes" hidden role="group" aria-label="Document view"><button data-document-mode="code" aria-pressed="true">Code</button><button data-document-mode="split" aria-pressed="false">Split</button><button data-document-mode="preview" aria-pressed="false">Preview</button></span><button id="reload-file" class="small-button">Reopen</button><button id="save-file" class="small-button">Save</button></div></div><div id="editor-empty" class="editor-empty">${icon('code')}<h2>Your workspace, ready.</h2><p>Choose a file to start editing.</p><div class="welcome-actions"><button id="empty-search">Go to file <kbd>Ctrl P</kbd></button><button id="empty-commands">All commands <kbd>Ctrl Shift P</kbd></button><button id="empty-terminal">Open terminal <kbd>Ctrl &#96;</kbd></button></div></div><div class="document-workspace"><div id="code-editor"></div><article id="document-preview" class="document-preview" aria-label="Document preview" hidden></article></div></div></section></main>
    <section id="terminal-panel" hidden><div id="terminal-resize" class="resize-handle" aria-label="Terminal height"></div><div class="terminal-toolbar"><span class="panel-label">TERMINAL</span><div id="terminal-tabs"></div><button id="new-terminal" class="icon-button" title="New terminal" aria-label="New terminal">+</button><button id="hide-terminal" class="icon-button" aria-label="Hide terminal" title="Hide terminal">−</button><button id="close-terminal" class="icon-button" aria-label="Close terminal" title="Close terminal">×</button></div><div id="terminal-content"></div></section>
    <footer class="statusbar"><span><span class="dot"></span> <span id="status-text">Aurea Code</span></span><span id="cursor-position"></span><span id="status-file">UTF-8 <span class="status-separator">·</span> Rust + Tauri</span><button id="show-terminal">${icon('terminal')} Terminal</button></footer>
  </div><div id="toast" role="status" aria-live="polite" hidden></div><dialog id="modal"></dialog><dialog id="discard-modal" aria-labelledby="discard-title"><form method="dialog"><h2 id="discard-title">Unsaved changes</h2><p id="discard-message"></p><div class="modal-actions"><button id="discard-cancel" class="small-button" value="cancel" autofocus>Cancel</button><button id="discard-confirm" class="primary-button" value="discard">Discard changes</button></div></form></dialog>`;

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
const editor = new CodeEditor(element('#code-editor'), updateEditorTitle, notify, updateCursorPosition);
const documentPreview = new DocumentPreview(element('#document-preview'), element('#code-editor'), element('#document-modes'), () => editor.view?.requestMeasure());
const terminals = new TerminalManager(element('#terminal-panel'), element('#terminal-tabs'), element('#terminal-content'), notify);
function notify(message: string) { const toast = element('#toast'); toast.textContent = message; toast.hidden = false; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; }, 9000); }
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
async function canDiscard(all = true) { return !(all ? editor.hasUnsavedChanges : editor.dirty) || confirmDiscard('You have unsaved changes in open files. Discard them?'); }
function refreshSidebar() {
  const active = workspace(); workspaceId = active.id; localStorage.setItem('aurea.workspace', workspaceId);
  element<HTMLSelectElement>('#workspace-select').innerHTML = db.workspaces.map(w => `<option value="${html(w.id)}" ${w.id === active.id ? 'selected' : ''}>${html(w.name)}</option>`).join('');
  element('#workspace-name').textContent = active.name; element('#project-count').textContent = String(projects().length);
  element('#project-shortcuts').innerHTML = projects().map(p => `<button class="project-shortcut ${p.id === projectId ? 'selected' : ''}" data-project="${html(p.id)}">${icon('folder')}<span>${html(p.name)}</span></button>`).join('') || '<p class="sidebar-hint">Your projects appear here.</p>';
  bind('[data-project]', button => openProject(button.dataset.project!));
  document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', (node as HTMLElement).dataset.page === page));
}
async function navigate(next: Page) {
  if (['editor', 'git', 'docker'].includes(next) && !projectId) { notify('Open a project to use its tools.'); return; }
  if (['projects', 'settings'].includes(next) && projectId) {
    if (!await canDiscard()) return;
    if (terminals.running && !await confirmAction('Returning to the launcher will close this project\'s terminals. Continue?')) return;
    await terminals.closeAll(); editor.close(); projectId = ''; treeRevision++;
  }
  stage = projectId ? 'ide' : 'launcher'; app.dataset.stage = stage;
  element('#ide-header').hidden = stage !== 'ide'; element('#ide-navigation').hidden = stage !== 'ide';
  if (stage === 'ide') { element('#ide-project-name').textContent = project().name; element('#ide-project-path').textContent = project().path; }
  page = next; pageRevision++; refreshSidebar();
    const names = { projects: 'Projects', editor: projectId ? project().name : 'Editor', git: 'Source control', docker: 'Docker', settings: 'Environment' };
    element('#page-name').textContent = names[page];
    element('#editor-page').hidden = stage !== 'ide'; content.hidden = page === 'editor';
    app.dataset.tool = page;
    element('#explorer-root').textContent = projectId ? project().name : '';
    if (page === 'editor') content.replaceChildren();
    if (page === 'projects') renderProjects();
    else if (page === 'git') await renderGit();
    else if (page === 'docker') await renderDocker();
    else if (page === 'settings') await renderSettings();
    editor.view?.requestMeasure();
}
function heading(eyebrow: string, title: string, description: string, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}${stage === 'ide' ? '<button id="close-tool" class="icon-button" aria-label="Close tool panel" title="Close tool panel">×</button>' : ''}</div>`; }
function renderProjects() {
  const list = projects();
  content.innerHTML = heading('WELCOME TO AUREA CODE', 'Projects', 'Choose where to continue working.', `<button id="add-project" class="primary-button">${icon('folder')} Open folder</button>`) + `
    <div class="list-heading"><h2>In this workspace</h2><label class="search-field">${icon('search')}<input id="project-search" placeholder="Search projects…" aria-label="Search projects"></label></div>
    <div id="project-grid" class="project-grid">${list.map(p => `<article class="project-card" data-card-name="${html((p.name + ' ' + p.path).toLowerCase())}"><span class="folder-tile">${icon('folder')}</span><div><button class="project-title" data-project="${html(p.id)}">${html(p.name)}</button><p class="project-path" title="${html(p.path)}">${html(p.path)}</p></div><button data-project="${html(p.id)}" class="small-button">Open ${icon('arrow')}</button></article>`).join('') || '<div class="empty-state"><h2>Your next project starts here.</h2><p>Open a folder on your computer to enter the IDE.</p></div>'}</div>
    `;
  bind('#add-project, #add-project-card', addProject); bind('[data-project]', b => openProject(b.dataset.project!));
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
async function renderTree() {
  const revision = ++treeRevision; const id = projectId; const tree = element('#file-tree'); tree.replaceChildren();
  async function load(relative: string, parent: HTMLElement) {
    const entries = await invoke<FileEntry[]>('list_files', { projectId: id, relative }); if (id !== projectId || revision !== treeRevision) return;
    for (const entry of entries) {
      if (entry.directory) {
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.innerHTML = folderIconMarkup(); const label = document.createElement('span'); label.textContent = entry.name; summary.append(label); summary.title = entry.path; details.append(summary); parent.append(details);
        let loaded = false;
        details.ontoggle = () => { if (details.open && !loaded) { loaded = true; const children = document.createElement('div'); children.className = 'tree-children'; details.append(children); void load(entry.path, children).catch(e => { loaded = false; children.remove(); notify(String(e)); }); } };
      } else {
        const button = document.createElement('button'); button.className = 'file-button'; button.innerHTML = fileIconMarkup(entry.path); const label = document.createElement('span'); label.className = 'file-label'; label.textContent = entry.name; button.append(label); button.title = entry.path; button.setAttribute('aria-label', `${entry.name} (${fileIconFor(entry.path).label})`);
        button.onclick = () => void perform(() => editor.open(id, entry.path));
        button.ondblclick = () => void perform(() => editor.open(id, entry.path, true)); parent.append(button);
      }
    }
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted tree-empty'; empty.textContent = 'Empty folder'; parent.append(empty); }
  }
  await load('', tree);
}
function renderEditorTabs() {
  const host = element('#editor-tabs');
  host.hidden = editor.tabs.length === 0;
  for (const node of Array.from(host.children)) {
    if (!editor.tabs.some(tab => String(tab.id) === (node as HTMLElement).dataset.tabId)) node.remove();
  }
  for (const [index, tab] of editor.tabs.entries()) {
    let node = Array.from(host.children).find(child => (child as HTMLElement).dataset.tabId === String(tab.id)) as HTMLElement | undefined;
    if (!node) {
      node = document.createElement('div'); node.className = 'editor-tab'; node.dataset.tabId = String(tab.id);
      const select = document.createElement('button'); select.className = 'editor-tab-select'; select.setAttribute('role', 'tab'); select.innerHTML = fileIconMarkup(tab.path); const name = document.createElement('span'); name.className = 'tab-file-name'; name.textContent = tab.path.split('/').pop()!; const dirty = document.createElement('span'); dirty.className = 'tab-dirty'; dirty.textContent = '●'; dirty.setAttribute('aria-hidden', 'true'); select.append(name, dirty);
      select.onclick = () => void perform(() => editor.open(tab.projectId, tab.path));
      select.ondblclick = () => editor.pin(tab);
      select.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = editor.tabs.indexOf(tab);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? editor.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + editor.tabs.length) % editor.tabs.length;
        const target = editor.tabs[next];
        void perform(async () => { await editor.open(target.projectId, target.path); host.querySelector<HTMLButtonElement>(`[data-tab-id="${target.id}"] .editor-tab-select`)?.focus(); });
      };
      const close = document.createElement('button'); close.className = 'editor-tab-close'; close.textContent = '×';
      close.onclick = () => void perform(async () => { if (editor.isDirty(tab) && !await confirmDiscard(`Close ${tab.path} and discard its unsaved changes?`)) return; editor.closeTab(tab); });
      node.append(select, close); host.append(node);
    }
    if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null);
    const active = editor.file === tab;
    node.classList.toggle('active', active); node.classList.toggle('temporary', !tab.pinned);
    const select = node.querySelector<HTMLButtonElement>('.editor-tab-select')!;
    select.querySelector<HTMLElement>('.tab-dirty')!.hidden = !editor.isDirty(tab);
    select.setAttribute('aria-label', `${tab.path} (${fileIconFor(tab.path).label})${editor.isDirty(tab) ? ' — Unsaved changes' : ''}`);
    select.title = `${tab.path}${tab.pinned ? '' : ' — Preview (double-click to keep open)'}`;
    select.setAttribute('aria-selected', String(active)); select.tabIndex = active ? 0 : -1;
    node.querySelector('.editor-tab-close')!.setAttribute('aria-label', `Close ${tab.path}`);
  }
}
function updateCursorPosition() {
  const selection = editor.view?.state.selection.main;
  const line = selection && editor.view?.state.doc.lineAt(selection.head);
  element('#cursor-position').textContent = line && selection ? `Ln ${line.number}, Col ${selection.head - line.from + 1}` : '';
}
function updateEditorTitle() {
  renderEditorTabs();
  document.querySelectorAll<HTMLElement>('.file-button').forEach(button => button.classList.toggle('selected', button.title === editor.file?.path));
  documentPreview.update(editor.file ? `${editor.file.projectId}/${editor.file.path}` : '', editor.view?.state.doc.toString() ?? '');
  updateCursorPosition();
  element('#status-file').textContent = editor.file ? `UTF-8 · ${editor.languageName}` : 'UTF-8 · Rust + Tauri';
  element('#editor-title').textContent = editor.file ? `${editor.dirty ? '● ' : ''}${editor.file.path}` : 'Select a file';
  element('#editor-empty').hidden = !!editor.file;
  element('.document-workspace').hidden = !editor.file;
  element<HTMLButtonElement>('#save-file').disabled = !editor.dirty;
  element<HTMLButtonElement>('#reload-file').disabled = !editor.file;
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
  if (editor.hasUnsavedChanges && !await confirmDiscard('Quit and discard unsaved changes in open files?')) return;
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
bind('[data-page]', b => navigate(stage === 'ide' && page === b.dataset.page && page !== 'editor' ? 'editor' : b.dataset.page as Page));
bind('#start-shell, #new-terminal, #empty-terminal', () => { desktop(); return terminals.start(project(), 'shell'); });
bind('#back-launcher', () => navigate('projects')); bind('#ide-reveal', () => invoke('reveal_project', { projectId }));
bind('#new-workspace', newWorkspace); bind('#open-top', addProject);
bind('#new-file', () => { const current = project(); formDialog('New file', '<label>Path relative to the project<input name="path" placeholder="e.g. src/main.rs" required></label><p class="muted">The destination folder must exist. Existing files will not be overwritten.</p>', async data => { const path = String(data.get('path')); await invoke('create_file', { projectId: current.id, relative: path }); await renderTree(); await editor.open(current.id, path, true); }); });
element('#document-preview').onclick = event => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-document-link]');
  if (!link || !editor.file) return;
  void perform(async () => {
    const target = resolveDocumentLink(editor.file!.path, link.dataset.documentLink!);
    if (target.external) { await invoke('open_document_link', { url: target.external }); return; }
    if (target.path) await editor.open(editor.file!.projectId, target.path);
  });
};
bind('#save-file', () => editor.save()); bind('#reload-file', async () => { if (editor.file && await canDiscard(false)) await editor.reload(); }); bind('#refresh-files', renderTree);
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
          run: async () => { if (projectId !== id) return; await editor.open(id, entry.path, true); }
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
    action('Toggle explorer', 'Ctrl B', toggleExplorer),
    action('New terminal', 'Project', () => terminals.start(project(), 'shell')),
    action('Source control', 'Git', () => navigate('git')),
    action('Docker Compose', 'Containers', () => navigate('docker')),
    action('Focus editor', 'Escape tool view', () => navigate('editor')),
    action('Return to projects', 'Launcher', () => navigate('projects')),
  ] }));
}
content.addEventListener('click', event => { if ((event.target as HTMLElement).closest('#close-tool')) void perform(() => navigate('editor')); });
bind('#quick-open, #empty-search', openQuickFiles);
bind('#commands, #empty-commands', openCommands);
bind('#toggle-explorer', toggleExplorer);
bind('#collapse-folders', () => document.querySelectorAll<HTMLDetailsElement>('#file-tree details').forEach(node => { node.open = false; }));
resizePanel(element('#explorer-resize'), app, '--explorer-width', 'aurea.explorer-width', 240, 160, () => Math.min(480, window.innerWidth * .4), 'x');
resizePanel(element('#terminal-resize'), app, '--terminal-height', 'aurea.terminal-height', 240, 100, () => window.innerHeight * .65, 'y');
window.addEventListener('keydown', event => {
  if (!projectId || document.querySelector('dialog[open]')) return;
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'p') { event.preventDefault(); void perform(event.shiftKey ? openCommands : openQuickFiles); }
    else if (event.key.toLowerCase() === 'b') { event.preventDefault(); toggleExplorer(); }
    else if (event.key === '`') { event.preventDefault(); if (!element('#terminal-panel').hidden) terminals.hide(); else element<HTMLButtonElement>('#show-terminal').click(); }
    else if (event.key.toLowerCase() === 'w' && editor.file) {
      event.preventDefault(); element<HTMLButtonElement>('.editor-tab.active .editor-tab-close').click();
    }
  }
});
async function boot() {
  if (isTauri()) {
    await updateWindowControls();
    await getCurrentWindow().onResized(() => void perform(updateWindowControls));
    db = await invoke<Database>('load_workspace'); trayReady = await invoke('desktop_status');
    await listen<string>('native-action', event => void perform(async () => {
      const action = event.payload;
      if (action === 'open') await addProject(); else if (action === 'workspace') { await navigate('projects'); if (!projectId) newWorkspace(); } else if (action === 'save') await editor.save(); else if (action === 'quit') await quit(); else if (action === 'terminal') await terminals.start(project(), 'shell'); else if (['projects', 'git', 'docker'].includes(action)) await navigate(action as Page);
    }));
    window.setInterval(() => { if (document.visibilityState === 'visible') void editor.sync(); }, 3000);
    window.addEventListener('focus', () => { void editor.sync(); });
  } else element('#preview-banner').hidden = false;
  element('#status-text').textContent = isTauri() ? 'Local environment' : 'Preview';
  updateEditorTitle(); refreshSidebar(); await navigate('projects');
}
void boot().catch(error => { app.dataset.stage = 'launcher'; content.innerHTML = `<div class="empty-state"><h2>Unable to open workspaces.</h2><p>${html(String(error))}</p><p>Existing data has not been overwritten.</p></div>`; });
