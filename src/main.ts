import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import { CodeEditor } from './editor';
import { TerminalManager } from './terminals';
import { escapeHtml as html, parseContainers } from './utils.mjs';
import type { Database, FileEntry, Page, Profile, Project, ToolStatus } from './types';
import './style.css';

const icons: Record<string, string> = {
  projects: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 8-12 2-12 8"/>',
  docker: '<path d="M3 12h16c2 0 3-2 3-2 0 8-4 11-10 11S2 18 2 14"/><path d="M5 12V8h4v4m0-4V4h4v8m0-4h4v4"/>',
  accounts: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-17a3 3 0 0 1 0 6m2 4c3 1 3 3 3 6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  code: '<path d="m7 6-6 6 6 6m10-12 6 6-6 6m-3-15-4 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
function icon(name: string) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.code}</svg>`; }
function element<T extends HTMLElement>(selector: string) { const node = document.querySelector<T>(selector); if (!node) throw new Error(`Elemento ausente: ${selector}`); return node; }
const app = element<HTMLDivElement>('#app');
app.innerHTML = `
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark">Λ</span><span>Aurea<span class="brand-light"> Code</span></span><span class="version">MVP</span></div>
    <div class="workspace-label">WORKSPACE <button id="new-workspace" class="icon-button" title="Novo workspace" aria-label="Novo workspace">+</button></div>
    <select id="workspace-select" aria-label="Workspace ativo"></select>
    <nav aria-label="Navegação principal">
      <button data-page="projects">${icon('projects')} Projetos <span id="project-count" class="count">0</span></button>
      <button data-page="accounts">${icon('accounts')} Contas de IA</button>
      <div class="nav-label">FERRAMENTAS</div>
      <button data-page="git">${icon('git')} Controlo de versão</button>
      <button data-page="docker">${icon('docker')} Docker</button>
    </nav>
    <div class="sidebar-projects"><div class="nav-label">NESTE WORKSPACE</div><div id="project-shortcuts"></div></div>
    <div class="sidebar-bottom"><button data-page="settings">${icon('settings')} Ambiente</button><div class="local-indicator"><span class="dot"></span> Local, por natureza <span>↗</span></div></div>
  </aside>
  <div class="main-shell">
    <header class="topbar"><div class="breadcrumb"><span id="workspace-name">Pessoal</span><span>/</span><strong id="page-name">Projetos</strong></div><div class="top-actions"><span class="shortcut">Ctrl + O</span><button id="open-top" class="small-button">${icon('folder')} Abrir projeto</button></div></header>
    <div id="preview-banner" hidden>Pré-visualização da interface. Abra a aplicação desktop para usar ficheiros, contas, Git e Docker.</div>
    <main id="content"><section id="page-content"></section><section id="editor-page" hidden><aside class="file-sidebar"><div class="section-heading"><span>EXPLORADOR</span><button id="new-file" class="icon-button" title="Novo ficheiro" aria-label="Novo ficheiro">+</button><button id="refresh-files" class="icon-button" title="Atualizar ficheiros">↻</button></div><div id="file-tree"></div></aside><div class="editor-area"><div class="editor-toolbar"><span id="editor-title">Selecione um ficheiro</span><div><button id="reload-file" class="small-button">Reabrir</button><button id="save-file" class="small-button">Guardar</button></div></div><div id="editor-empty" class="editor-empty">${icon('code')}<h2>Espaço para criar.</h2><p>Abra um ficheiro no explorador ou inicie um agente.</p></div><div id="code-editor"></div></div></section></main>
    <section id="terminal-panel" hidden><div class="terminal-toolbar"><div id="terminal-tabs"></div><button id="hide-terminal" class="icon-button" aria-label="Ocultar terminal" title="Ocultar terminal">−</button><button id="close-terminal" class="icon-button" aria-label="Encerrar terminal" title="Encerrar terminal">×</button></div><div id="terminal-content"></div></section>
    <footer class="statusbar"><span><span class="dot"></span> <span id="status-text">Aurea Code</span></span><span id="status-file">UTF-8 <span class="status-separator">·</span> Rust + Tauri</span><button id="show-terminal">${icon('terminal')} Terminal</button></footer>
  </div><div id="toast" role="status" aria-live="polite" hidden></div><dialog id="modal"></dialog>`;

let db: Database = { version: 1, workspaces: [{ id: 'preview', name: 'Pessoal', profile_ids: [] }], profiles: [], projects: [] };
let tools: ToolStatus[] = [];
let workspaceId = localStorage.getItem('aurea.workspace') ?? '';
let projectId = '';
let page: Page = 'projects';
let pageRevision = 0;
let toastTimer = 0;
let trayReady = false;
let treeRevision = 0;
const content = element<HTMLElement>('#page-content');
const editor = new CodeEditor(element('#code-editor'), updateEditorTitle, notify);
const terminals = new TerminalManager(element('#terminal-panel'), element('#terminal-tabs'), element('#terminal-content'), notify);
function notify(message: string) { const toast = element('#toast'); toast.textContent = message; toast.hidden = false; window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; }, 9000); }
function desktop() { if (!isTauri()) throw new Error('Esta função está disponível na aplicação desktop.'); }
function workspace() { return db.workspaces.find(w => w.id === workspaceId) ?? db.workspaces[0]; }
function projects() { return db.projects.filter(p => p.workspace_id === workspace().id); }
function project() { const value = db.projects.find(p => p.id === projectId); if (!value) throw new Error('Abra um projeto primeiro.'); return value; }
function profiles() { return db.profiles.filter(p => workspace().profile_ids.includes(p.id)); }
async function perform(action: () => Promise<unknown>) { try { await action(); } catch (error) { notify(String(error)); } }
function bind(selector: string, action: (button: HTMLButtonElement) => Promise<unknown> | unknown) {
  document.querySelectorAll<HTMLButtonElement>(selector).forEach(button => { button.onclick = () => { button.disabled = true; void perform(async () => { try { await action(button); } finally { button.disabled = false; updateEditorTitle(); } }); }; });
}
async function confirmAction(message: string) { desktop(); return confirm(message, { title: 'Aurea Code', kind: 'warning', okLabel: 'Continuar', cancelLabel: 'Cancelar' }); }
async function canDiscard() { return !editor.dirty || confirmAction('Existem alterações por guardar. Descartar estas alterações?'); }
function refreshSidebar() {
  const active = workspace(); workspaceId = active.id; localStorage.setItem('aurea.workspace', workspaceId);
  element<HTMLSelectElement>('#workspace-select').innerHTML = db.workspaces.map(w => `<option value="${html(w.id)}" ${w.id === active.id ? 'selected' : ''}>${html(w.name)}</option>`).join('');
  element('#workspace-name').textContent = active.name; element('#project-count').textContent = String(projects().length);
  element('#project-shortcuts').innerHTML = projects().map(p => `<button class="project-shortcut ${p.id === projectId ? 'selected' : ''}" data-project="${html(p.id)}">${icon('folder')}<span>${html(p.name)}</span></button>`).join('') || '<p class="sidebar-hint">Os seus projetos aparecem aqui.</p>';
  bind('[data-project]', button => openProject(button.dataset.project!));
  document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', (node as HTMLElement).dataset.page === (page === 'editor' ? 'projects' : page)));
}
async function navigate(next: Page) {
  if (next === 'git' && !projectId) { notify('Abra um projeto para consultar o Git.'); return; }
  page = next; pageRevision++; refreshSidebar();
    const names = { projects: 'Projetos', editor: projectId ? project().name : 'Editor', accounts: 'Contas de IA', git: 'Controlo de versão', docker: 'Docker', settings: 'Ambiente' };
    element('#page-name').textContent = names[page];
    element('#editor-page').hidden = page !== 'editor'; content.hidden = page === 'editor';
    document.querySelector('.editor-agent-bar')?.remove();
    if (page === 'editor') { content.replaceChildren(); renderEditorActions(); }
    if (page === 'projects') renderProjects();
    else if (page === 'accounts') renderAccounts();
    else if (page === 'git') await renderGit();
    else if (page === 'docker') await renderDocker();
    else if (page === 'settings') await renderSettings();
    else { editor.view?.requestMeasure(); }
}
function heading(eyebrow: string, title: string, description: string, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function agentControls() { return `<div class="agent-controls"><select id="agent-profile" aria-label="Conta do agente">${profiles().map(p => `<option value="${html(p.id)}">${html(p.provider === 'codex' ? 'Codex' : 'Claude')} · ${html(p.name)}</option>`).join('') || '<option value="">Adicione uma conta de IA</option>'}</select><button id="start-agent" class="primary-button">${icon('terminal')} Iniciar agente</button><button id="start-shell" class="small-button">Terminal</button></div>`; }
function wireAgents() {
  bind('#start-agent', async () => { desktop(); const selected = profiles().find(p => p.id === element<HTMLSelectElement>('#agent-profile').value); if (!selected) { await navigate('accounts'); return; } await terminals.start(project(), 'agent', selected); });
  bind('#start-shell', () => { desktop(); return terminals.start(project(), 'shell'); });
}
function renderProjects() {
  const list = projects();
  content.innerHTML = heading('O SEU ESPAÇO DE TRABALHO', 'Boas ideias começam aqui.', 'Projetos organizados. Agentes ao seu lado. Espaço para se concentrar.', `<button id="add-project" class="primary-button">${icon('plus')} Adicionar projeto</button>`) + `
    <div class="overview"><div><span class="overview-icon">${icon('folder')}</span><span><strong>${list.length}</strong><small>Projetos locais</small></span></div><div><span class="overview-icon">${icon('accounts')}</span><span><strong>${profiles().length}</strong><small>Contas neste workspace</small></span></div><div><span class="overview-icon">${icon('terminal')}</span><span><strong>${terminals.running}</strong><small>Terminais em execução</small></span></div><div class="workspace-note"><span class="dot"></span> No seu computador</div></div>
    <div class="list-heading"><h2>Os seus projetos <span class="muted">${list.length ? ` / ${list.length}` : ''}</span></h2><label class="search-field">${icon('search')}<input id="project-search" placeholder="Procurar projeto…" aria-label="Procurar projeto"></label></div>
    <div id="project-grid" class="project-grid">${list.map(p => `<article class="project-card" data-card-name="${html(p.name.toLowerCase())}"><div class="card-top"><span class="folder-tile">${icon('folder')}</span><span class="badge">Local</span></div><button class="project-title" data-project="${html(p.id)}">${html(p.name)}</button><p class="project-path" title="${html(p.path)}">${html(p.path)}</p><div class="card-bottom"><span>${icon('code')} Pronto para abrir</span><button data-project="${html(p.id)}" class="icon-button" aria-label="Abrir ${html(p.name)}">${icon('arrow')}</button></div></article>`).join('')}
    <button id="add-project-card" class="add-project-card">${icon('plus')}<strong>${list.length ? 'Mais um projeto' : 'O seu primeiro projeto'}</strong><span>Abra uma pasta do computador</span></button></div>
    ${projectId ? `<div class="active-project-strip"><div><span class="eyebrow">PROJETO ATIVO</span><strong>${html(project().name)}</strong></div>${agentControls()}</div>` : ''}
    <div class="getting-started"><div class="spark">✳</div><div><h3>O seu código. A sua forma de trabalhar.</h3><p>Associe contas Codex e Claude ao workspace e inicie os agentes diretamente nos seus projetos.</p></div><button id="configure-accounts" class="text-button">Configurar contas ${icon('arrow')}</button></div>`;
  bind('#add-project, #add-project-card', addProject); bind('[data-project]', b => openProject(b.dataset.project!)); bind('#configure-accounts', () => navigate('accounts')); wireAgents();
  element<HTMLInputElement>('#project-search').oninput = event => { const query = (event.target as HTMLInputElement).value.toLowerCase(); document.querySelectorAll<HTMLElement>('[data-card-name]').forEach(card => { card.hidden = !card.dataset.cardName!.includes(query); }); };
}
async function addProject() {
  desktop(); const path = await open({ directory: true, multiple: false, title: 'Selecione ou crie a pasta do projeto' }); if (!path) return;
  db = await invoke<Database>('add_project', { workspaceId, path }); const added = db.projects.find(p => p.path === path && p.workspace_id === workspaceId) ?? db.projects.at(-1)!; await openProject(added.id);
}
async function openProject(id: string) {
  desktop(); if (id !== projectId && !await canDiscard()) return;
  if (id !== projectId) editor.close(); projectId = id;
  await navigate('editor'); await renderTree();
}
function renderEditorActions() {
  const bar = document.createElement('div'); bar.className = 'editor-agent-bar'; bar.innerHTML = `<button id="project-git" class="small-button">${icon('git')} Git</button><button id="reveal-project" class="small-button">${icon('folder')} Pasta</button>${agentControls()}`;
  document.querySelector('.editor-agent-bar')?.remove(); element('.editor-area').append(bar);
  bind('#project-git', () => navigate('git')); bind('#reveal-project', () => invoke('reveal_project', { projectId })); wireAgents();
}
async function renderTree() {
  const revision = ++treeRevision; const id = projectId; const tree = element('#file-tree'); tree.replaceChildren();
  async function load(relative: string, parent: HTMLElement) {
    const entries = await invoke<FileEntry[]>('list_files', { projectId: id, relative }); if (id !== projectId || revision !== treeRevision) return;
    for (const entry of entries) {
      if (entry.directory) {
        const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = entry.name; details.append(summary); parent.append(details);
        let loaded = false;
        details.ontoggle = () => { if (details.open && !loaded) { loaded = true; const children = document.createElement('div'); children.className = 'tree-children'; details.append(children); void load(entry.path, children).catch(e => { loaded = false; children.remove(); notify(String(e)); }); } };
      } else {
        const button = document.createElement('button'); button.className = 'file-button'; button.textContent = entry.name; button.title = entry.path;
        button.onclick = () => void perform(async () => { if (!await canDiscard()) return; await editor.open(id, entry.path); document.querySelectorAll('.file-button').forEach(b => b.classList.remove('selected')); button.classList.add('selected'); }); parent.append(button);
      }
    }
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted tree-empty'; empty.textContent = 'Pasta vazia'; parent.append(empty); }
  }
  await load('', tree);
}
function updateEditorTitle() {
  element('#editor-title').textContent = editor.file ? `${editor.dirty ? '● ' : ''}${editor.file.path}` : 'Selecione um ficheiro';
  element('#editor-empty').hidden = !!editor.file; element('#code-editor').hidden = !editor.file;
  element<HTMLButtonElement>('#save-file').disabled = !editor.dirty;
  element<HTMLButtonElement>('#reload-file').disabled = !editor.file;
}
function formDialog(title: string, fields: string, submit: (data: FormData) => Promise<void>) {
  const modal = element<HTMLDialogElement>('#modal');
  modal.innerHTML = `<form id="modal-form"><div class="modal-heading"><h2>${title}</h2><button type="button" id="modal-close" class="icon-button" aria-label="Fechar">×</button></div>${fields}<p id="modal-error" role="alert"></p><div class="modal-actions"><button type="button" id="modal-cancel" class="small-button">Cancelar</button><button type="submit" class="primary-button">Criar</button></div></form>`;
  bind('#modal-close, #modal-cancel', () => modal.close());
  element<HTMLFormElement>('#modal-form').onsubmit = event => { event.preventDefault(); const button = modal.querySelector<HTMLButtonElement>('[type="submit"]')!; button.disabled = true;
    void submit(new FormData(event.target as HTMLFormElement)).then(() => modal.close()).catch(error => { element('#modal-error').textContent = String(error); }).finally(() => { button.disabled = false; }); };
  modal.showModal(); modal.querySelector<HTMLInputElement>('input')?.focus();
}
function newWorkspace() { desktop(); formDialog('Novo workspace', '<label>Nome<input name="title" placeholder="Ex.: Trabalho" maxlength="80" required autocomplete="off"></label><p class="muted">Agrupe projetos e escolha as contas de IA que pretende usar.</p>', async data => { if (!await canDiscard()) return; db = await invoke('create_workspace', { title: data.get('title') }); workspaceId = db.workspaces.at(-1)!.id; projectId = ''; editor.close(); await navigate('projects'); }); }
function renderAccounts() {
  content.innerHTML = heading('CODEX & CLAUDE', 'Cada conta no seu espaço.', 'Perfis locais com configurações e sessões separadas, associados a este workspace.', `<button id="new-profile" class="primary-button">${icon('plus')} Nova conta</button>`) + `<div class="account-grid">${profiles().map(p => `<article class="account-card"><div class="provider-mark ${p.provider}">${p.provider === 'codex' ? '✳' : '✴'}</div><h2>${html(p.name)}</h2><p>${p.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'}</p><span class="badge">Perfil local</span><p class="account-help">O login e a identidade ativa são apresentados pelo CLI oficial ao abrir o agente.</p><button class="small-button" data-connect="${html(p.id)}">Abrir agente / iniciar sessão ${icon('arrow')}</button></article>`).join('') || '<div class="empty-state"><span class="empty-icon">✳</span><h2>Traga os seus agentes.</h2><p>Crie um perfil para cada conta pessoal ou profissional.<br>As credenciais são geridas pelos CLIs oficiais.</p></div>'}</div><div class="info-box"><h3>Como funciona</h3><p>Crie um perfil, abra um projeto e inicie o agente. Conclua o login no terminal oficial. Para trocar de conta, abra uma nova sessão com outro perfil; as sessões já abertas mantêm a conta original.</p><p>Os perfis separam configurações. Os processos continuam a ter as permissões do seu utilizador no sistema operativo.</p></div>${db.profiles.some(p => !workspace().profile_ids.includes(p.id)) ? `<div class="link-profile"><h3>Usar uma conta de outro workspace</h3><select id="existing-profile" aria-label="Conta existente">${db.profiles.filter(p => !workspace().profile_ids.includes(p.id)).map(p => `<option value="${html(p.id)}">${html(p.name)} · ${html(p.provider)}</option>`).join('')}</select><button id="link-profile" class="small-button">Associar conta</button></div>` : ''}`;
  bind('#new-profile', () => { desktop(); formDialog('Nova conta de IA', '<label>Nome do perfil<input name="title" placeholder="Ex.: Codex pessoal" maxlength="80" required></label><label>Agente<select name="provider"><option value="codex">OpenAI Codex</option><option value="claude">Claude Code</option></select></label>', async data => { db = await invoke('create_profile', { workspaceId, title: data.get('title'), provider: data.get('provider') }); refreshSidebar(); renderAccounts(); }); });
  bind('[data-connect]', async b => { desktop(); await terminals.start(project(), 'agent', profiles().find(p => p.id === b.dataset.connect)); });
  bind('#link-profile', async () => { db = await invoke('link_profile', { workspaceId, profileId: element<HTMLSelectElement>('#existing-profile').value }); renderAccounts(); });
}
async function renderGit() {
  const current = project(); const revision = pageRevision;
  content.innerHTML = heading('CONTROLO DE VERSÃO', html(current.name), 'Reveja alterações e crie commits sem sair do seu projeto.', '<button id="git-refresh" class="small-button">↻ Atualizar</button>') + `<div class="git-layout"><div><h3>Estado do repositório</h3><pre id="git-status" class="output">A consultar…</pre><div class="button-row"><button id="git-stage" class="small-button">Preparar tudo</button><button id="git-unstage" class="small-button">Retirar do staging</button></div><label class="commit-label">Mensagem de commit<textarea id="commit-message" placeholder="feat: describe your change" rows="3" maxlength="4096"></textarea></label><button id="git-commit" class="primary-button">${icon('check')} Criar commit</button><p class="muted small">Os hooks do repositório são respeitados.</p></div><div><div class="tabs"><button data-git-view="diff" class="active">Alterações</button><button data-git-view="staged">Staging</button><button data-git-view="log">Histórico</button></div><pre id="git-output" class="output diff">A consultar…</pre></div></div>`;
  async function load(action: string) { desktop(); return invoke<string>('git_action', { projectId: current.id, action }); }
  bind('#git-refresh', renderGit);
  bind('[data-git-view]', async b => { const output = await load(b.dataset.gitView!); if (revision !== pageRevision) return; element('#git-output').textContent = output || 'Sem alterações.'; document.querySelectorAll('[data-git-view]').forEach(n => n.classList.toggle('active', n === b)); });
  bind('#git-stage, #git-unstage', async b => { if (!await confirmAction(b.id === 'git-stage' ? 'Adicionar todas as alterações deste projeto ao staging? Reveja o diff antes de criar o commit.' : 'Retirar as alterações do staging, mantendo os ficheiros no disco?')) return; await load(b.id === 'git-stage' ? 'stage' : 'unstage'); if (page === 'git') await renderGit(); });
  bind('#git-commit', async () => { const message = element<HTMLTextAreaElement>('#commit-message').value.trim(); if (!message) throw new Error('Escreva uma mensagem de commit.'); await invoke('git_action', { projectId: current.id, action: 'commit', message }); notify('Commit criado.'); if (page === 'git') await renderGit(); });
  try { const [status, diff] = await Promise.all([load('status'), load('diff')]); if (revision !== pageRevision) return; element('#git-status').textContent = status || 'Sem alterações.'; element('#git-output').textContent = diff || 'Sem alterações fora do staging.'; }
  catch (error) { if (revision === pageRevision) { element('#git-status').textContent = String(error); element('#git-output').textContent = 'Abra um projeto com um repositório Git inicializado.'; } }
}
async function renderDocker() {
  const revision = pageRevision;
  content.innerHTML = heading('AMBIENTE DE DESENVOLVIMENTO', 'Docker, por perto.', 'Containers do contexto Docker ativo no seu computador.', `<div class="button-row"><button id="compose-up" class="small-button">Compose up + build</button><button id="docker-refresh" class="primary-button">↻ Atualizar</button></div>`) + '<div id="docker-list" class="container-list"><p class="muted">A consultar o Docker…</p></div><pre id="docker-output" class="output" hidden></pre>';
  bind('#docker-refresh', renderDocker);
  bind('#compose-up', async () => { desktop(); const current = project(); if (!await confirmAction(`Construir imagens e iniciar os serviços do Compose em ${current.name}? O ficheiro Compose deste projeto será executado.`)) return; await terminals.start(current, 'compose'); });
  try {
    desktop(); const output = await invoke<string>('docker_action', { action: 'list' }); if (revision !== pageRevision) return;
    const containers = parseContainers(output);
    element('#docker-list').innerHTML = containers.map(c => `<article class="container-row"><span class="container-icon">${icon('docker')}</span><div class="container-name"><h3>${html(c.name)}</h3><p>${html(c.image)}</p><small>${html(c.ports)}</small></div><span class="badge ${c.state === 'running' ? 'running' : ''}">${html(c.status)}</span><div class="button-row"><button class="small-button" data-container="${html(c.id)}" data-docker-action="logs">Logs</button><button class="small-button" data-container="${html(c.id)}" data-docker-action="${c.state === 'running' ? 'stop' : 'start'}">${c.state === 'running' ? 'Parar' : 'Iniciar'}</button><button class="small-button" data-container="${html(c.id)}" data-docker-action="restart">Reiniciar</button></div></article>`).join('') || '<div class="empty-state"><h2>Nenhum container por aqui.</h2><p>Abra um projeto com Compose para iniciar os seus serviços.</p></div>';
    bind('[data-docker-action]', async b => { const action = b.dataset.dockerAction!; if (action !== 'logs' && !await confirmAction(`Executar “${action}” no container ${b.dataset.container!.slice(0, 12)} do contexto Docker ativo?`)) return; const result = await invoke<string>('docker_action', { action, container: b.dataset.container }); if (page !== 'docker') return; if (action === 'logs') { element('#docker-output').hidden = false; element('#docker-output').textContent = result || 'Sem logs.'; } else await renderDocker(); });
  } catch (error) { if (revision === pageRevision) { element('#docker-list').innerHTML = `<div class="empty-state"><h2>Docker indisponível</h2><p>${html(String(error))}</p><p>Instale o Docker, inicie o daemon e confirme o contexto e as permissões do seu utilizador.</p></div>`; } }
}
async function renderSettings() {
  const revision = pageRevision;
  if (isTauri()) tools = await invoke('tools_status');
  if (revision !== pageRevision) return;
  content.innerHTML = heading('INTEGRAÇÃO COM O COMPUTADOR', 'Um ambiente preparado.', 'A Aurea usa as ferramentas instaladas no seu sistema.') + `<div class="settings-card"><h2>Ferramentas locais</h2>${['git', 'docker', 'codex', 'claude'].map(name => { const tool = tools.find(t => t.name === name); return `<div class="tool-row"><div><strong>${name}</strong><p>${html(tool?.path ?? 'Instale o executável nativo e disponibilize-o no PATH.')}</p></div><span class="badge ${tool?.available ? 'running' : ''}">${tool?.available ? 'Encontrado' : 'Não encontrado'}</span></div>`; }).join('')}</div><div class="settings-grid"><div class="settings-card"><h2>Integração desktop</h2><p>Menu nativo, atalhos, seleção de pastas e abertura no gestor de ficheiros.</p><p>${trayReady ? 'Ao fechar a janela, a aplicação permanece na bandeja. Use Ficheiro → Sair para encerrar.' : 'A bandeja não está disponível neste ambiente. Fechar a janela apresenta a confirmação de saída.'}</p></div><div class="settings-card"><h2>Atualizações Linux</h2><p>O AppImage de release inclui a fonte de atualização do GitHub para o Gear Lever.</p><code>ItsAnunesS/aurea-code</code><p>A pesquisa e aplicação de atualizações são geridas pelas suas preferências no Gear Lever.</p></div></div><div class="info-box"><h3>Contas e segurança</h3><p>O login permanece nos CLIs oficiais. A Aurea não pede chaves API nem copia credenciais para os projetos. Os agentes, Git e Docker executam com as permissões do seu utilizador; abra apenas projetos em que confia.</p></div>`;
}
async function quit() {
  if (editor.dirty && !await confirmAction('Sair e descartar alterações por guardar?')) return;
  if (terminals.running && !await confirmAction('Existem terminais em execução. Sair vai encerrá-los. Serviços iniciados em background podem continuar ativos.')) return;
  await invoke('exit_app');
}
bind('[data-page]', b => navigate(b.dataset.page as Page));
bind('#new-workspace', newWorkspace); bind('#open-top', addProject);
bind('#new-file', () => { const current = project(); formDialog('Novo ficheiro', '<label>Caminho relativo ao projeto<input name="path" placeholder="Ex.: src/main.rs" required></label><p class="muted">A pasta de destino deve existir. Ficheiros existentes não serão substituídos.</p>', async data => { if (!await canDiscard()) return; const path = String(data.get('path')); await invoke('create_file', { projectId: current.id, relative: path }); await renderTree(); await editor.open(current.id, path); }); });
bind('#save-file', () => editor.save()); bind('#reload-file', async () => { if (editor.file && await canDiscard()) await editor.open(editor.file.projectId, editor.file.path); }); bind('#refresh-files', renderTree);
bind('#hide-terminal', () => terminals.hide()); bind('#close-terminal', async () => { if (await confirmAction('Encerrar este terminal? O processo em execução será interrompido.')) await terminals.closeSelected(); });
bind('#show-terminal', () => { desktop(); if (terminals.sessions.length) terminals.show(); else return terminals.start(project(), 'shell'); });
element<HTMLSelectElement>('#workspace-select').onchange = event => void perform(async () => { const next = (event.target as HTMLSelectElement).value; if (!await canDiscard()) { refreshSidebar(); return; } workspaceId = next; projectId = ''; editor.close(); await navigate('projects'); });
async function boot() {
  if (isTauri()) {
    db = await invoke<Database>('load_workspace'); trayReady = await invoke('desktop_status');
    await listen<string>('native-action', event => void perform(async () => {
      const action = event.payload;
      if (action === 'open') await addProject(); else if (action === 'workspace') newWorkspace(); else if (action === 'save') await editor.save(); else if (action === 'quit') await quit(); else if (action === 'terminal') await terminals.start(project(), 'shell'); else if (['projects', 'git', 'docker'].includes(action)) await navigate(action as Page);
    }));
    window.setInterval(() => { if (document.visibilityState === 'visible') void editor.sync(); }, 3000);
    window.addEventListener('focus', () => { void editor.sync(); });
  } else element('#preview-banner').hidden = false;
  element('#status-text').textContent = isTauri() ? 'Ambiente local' : 'Pré-visualização';
  updateEditorTitle(); await navigate('projects');
}
void boot().catch(error => { content.innerHTML = `<div class="empty-state"><h2>Não foi possível abrir os workspaces.</h2><p>${html(String(error))}</p><p>Os dados existentes não foram substituídos.</p></div>`; });
