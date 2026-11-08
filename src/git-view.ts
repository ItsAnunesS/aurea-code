import { invoke } from '@tauri-apps/api/core';
import { escapeHtml as html } from './utils.mjs';
import './git.css';
interface Change { path: string; originalPath: string | null; index: string; worktree: string }
interface Commit { hash: string; short: string; author: string; date: string; subject: string }
interface Stash { reference: string; hash: string; subject: string }
interface Snapshot { branch: string; changes: Change[]; commits: Commit[]; stashes: Stash[] }
export class GitView {
  private project = '';
  private state?: Snapshot;
  private mode = 'changes';
  private message = '';
  private busy = false;
  private revision = 0;
  private detailRevision = 0;
  private active = false;
  constructor(private host: HTMLElement, private report: (text: string) => void, private confirm: (text: string) => Promise<boolean>, private unsaved: () => boolean, private openFile: (project: string, path: string) => void) {}
  get running() { return this.busy; }
  deactivate() { this.active = false; this.revision++; this.detailRevision++; }
  async activate(id: string) {
    if (this.busy) throw new Error('Wait for the Git operation to finish.');
    if (this.project !== id) { this.project = id; this.state = undefined; this.message = ''; this.mode = 'changes'; }
    this.active = true; await this.refresh();
  }
  private async refresh() {
    const revision = ++this.revision; this.detailRevision++;
    if (!this.state) this.host.textContent = 'Loading repository…';
    try { const state = await invoke<Snapshot>('git_snapshot', { projectId: this.project }); if (revision !== this.revision) return; this.state = state; this.render(); }
    catch (error) { if (revision !== this.revision) return; this.host.replaceChildren(); const title = document.createElement('h2'); title.textContent = 'Git unavailable'; const text = document.createElement('p'); text.id = 'git-status'; text.textContent = String(error); this.host.append(title, text); }
  }
  private async run(action: string, target = '', message = '') {
    if (this.busy) return;
    this.busy = true; this.host.setAttribute('aria-busy', 'true'); this.disable(true);
    try {
      await (['commit', 'stage', 'unstage'].includes(action)
        ? await invoke<string>('git_action', { projectId: this.project, action, message })
        : await invoke<string>('git_workspace_action', { projectId: this.project, action, target, message }));
      if (action === 'commit') this.message = '';
      this.report(action === 'commit' ? 'Commit created.' : action === 'stash-save' ? 'Changes saved to stash.' : action === 'stash-apply' ? 'Stash applied. The saved copy was kept.' : 'Staging updated.');
    } catch (error) { this.report(String(error)); }
    finally { this.busy = false; this.host.removeAttribute('aria-busy'); if (this.active) await this.refresh(); }
  }
  private disable(value: boolean) { this.host.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach(node => { node.disabled = value; }); }
  private button(text: string, action: () => void, className = '') {
    const button = document.createElement('button'); button.textContent = text; button.className = className; button.onclick = action; button.disabled = this.busy; return button;
  }
  private async detail(key: string, action: string, target: string, title: string) {
    const revision = ++this.detailRevision;
    this.host.querySelectorAll<HTMLElement>('[data-git-key]').forEach(node => node.classList.toggle('selected', node.dataset.gitKey === key));
    const host = this.host.querySelector<HTMLElement>('.git-detail')!; host.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = title;
    const pre = document.createElement('pre'); pre.id = 'git-output'; pre.textContent = 'Loading diff…'; host.append(heading); const commit = this.state?.commits.find(commit => commit.hash === target); if (commit) { const meta = document.createElement('p'); meta.className = 'git-detail-meta'; meta.textContent = `${commit.author} · ${new Date(commit.date).toLocaleString()} · ${commit.short}`; host.append(meta); } if (action === 'file-diff' || action === 'index-diff') host.append(this.button('Open in editor', () => this.openFile(this.project, target), 'small-button')); host.append(pre);
    try {
      const output = await invoke<string>('git_workspace_action', { projectId: this.project, action, target, message: '' });
      if (revision !== this.detailRevision) return;
      pre.replaceChildren();
      if (!output) pre.textContent = 'No textual diff. Untracked files must be staged before reviewing their patch. Binary contents are not displayed.';
      else for (const line of output.split('\n')) { const row = document.createElement('span'); row.textContent = line + '\n'; row.className = line.startsWith('diff --git') ? 'diff-file' : line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : line.startsWith('@@') ? 'diff-hunk' : ''; pre.append(row); }
    } catch (error) { if (revision === this.detailRevision) pre.textContent = String(error); }
  }
  private render() {
    const state = this.state!;
    this.host.innerHTML = `<header class="git-header"><div><small>Source control</small><h1>${html(state.branch)}</h1></div><button id="git-refresh" class="small-button">Refresh</button><button id="close-tool" class="icon-button" aria-label="Close Git workspace">×</button></header><nav class="git-segments" aria-label="Repository views"></nav><div class="git-workspace"><section class="git-list"></section><section class="git-detail"><div class="git-welcome"><h2>Review your work.</h2><p>Select a file, commit or stash to see its changes.</p></div></section></div><footer id="git-status" role="status">${state.changes.length} changed files · ${state.commits.length} recent commits · ${state.stashes.length} stashes</footer>`;
    this.host.querySelector<HTMLButtonElement>('#git-refresh')!.onclick = () => void this.refresh();
    const nav = this.host.querySelector('.git-segments')!;
    for (const [key, label, count] of [['changes', 'Changes', state.changes.length], ['history', 'History', state.commits.length], ['stashes', 'Stashes', state.stashes.length]]) {
      const button = this.button(`${label} ${count}`, () => { this.mode = String(key); this.detailRevision++; this.render(); }); button.setAttribute('aria-pressed', String(this.mode === key)); nav.append(button);
    }
    const list = this.host.querySelector<HTMLElement>('.git-list')!;
    if (this.mode === 'changes') {
      const compose = document.createElement('div'); compose.className = 'git-compose';
      const input = document.createElement('textarea'); input.id = 'commit-message'; input.placeholder = 'Describe this commit…'; input.setAttribute('aria-label', 'Commit message'); input.value = this.message; input.oninput = () => { this.message = input.value; commit.disabled = !this.message.trim() || !staged.length || this.busy; };
      const staged = state.changes.filter(change => ![' ', '?'].includes(change.index));
      const commit = this.button('Commit staged changes', () => void this.run('commit', '', this.message), 'primary-button'); commit.id = 'git-commit'; commit.disabled = !this.message.trim() || !staged.length || this.busy;
      compose.append(input, commit); list.append(compose);
      if (this.unsaved()) { const note = document.createElement('p'); note.className = 'git-note'; note.textContent = 'Unsaved editor changes are not included. Save your files before staging.'; list.append(note); }
      this.section(list, 'Staged changes', staged, true);
      this.section(list, 'Working changes', state.changes.filter(change => change.worktree !== ' ' || change.index === '?'), false);
      if (!state.changes.length) { const empty = document.createElement('p'); empty.className = 'git-note'; empty.textContent = 'Working tree clean. Your changes will appear here.'; list.append(empty); }
    } else if (this.mode === 'history') {
      const note = document.createElement('p'); note.className = 'git-note'; note.textContent = 'Latest 100 commits on the current branch'; list.append(note);
      for (const commit of state.commits) {
        const row = this.button('', () => void this.detail(commit.hash, 'commit-detail', commit.hash, commit.subject), 'git-history-row'); row.dataset.gitKey = commit.hash;
        const title = document.createElement('strong'); title.textContent = commit.subject;
        const meta = document.createElement('small'); meta.textContent = `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleDateString()}`; row.append(title, meta); list.append(row);
      }
      if (!state.commits.length) list.append('No commits yet. Stage your first files to create one.');
    } else {
      const stashName = document.createElement('input'); stashName.placeholder = 'Stash name (optional)'; stashName.setAttribute('aria-label', 'Stash name'); stashName.className = 'git-stash-name'; list.append(stashName);
      const create = this.button('Save changes to stash…', () => void (async () => {
        if (this.unsaved()) { this.report('Save your editor changes before creating a stash.'); return; }
        if (await this.confirm('Store staged, working and untracked files in a stash and clean the working tree? Ignored files stay in place.')) await this.run('stash-save', '', stashName.value.trim() || 'Saved from Aurea');
      })(), 'small-button'); create.disabled = !state.changes.length || this.busy; list.append(create);
      const note = document.createElement('p'); note.className = 'git-note'; note.textContent = 'Applying a stash keeps the saved copy. Conflicts appear under Changes.'; list.append(note);
      for (const stash of state.stashes) {
        const row = document.createElement('div'); row.className = 'git-stash-row';
        const inspect = this.button(`${stash.reference} · ${stash.subject}`, () => void this.detail(stash.hash, 'stash-detail', stash.hash, stash.subject)); inspect.dataset.gitKey = stash.hash;
        const apply = this.button('Apply', () => void (async () => { if (this.unsaved()) { this.report('Save your editor changes before applying a stash.'); return; } if (await this.confirm('Apply this stash to the current working tree? The stash will be kept.')) await this.run('stash-apply', stash.hash); })(), 'small-button'); row.append(inspect, apply); list.append(row);
      }
      if (!state.stashes.length) list.append('No saved stashes.');
    }
    if (this.busy) this.disable(true);
  }
  private section(host: HTMLElement, title: string, changes: Change[], staged: boolean) {
    const heading = document.createElement('div'); heading.className = 'git-section'; const label = document.createElement('h2'); label.textContent = `${title} (${changes.length})`; heading.append(label);
    if (changes.length) { const all = this.button(staged ? 'Unstage all' : 'Stage all', () => void this.run(staged ? 'unstage-all' : 'stage')); all.id = staged ? 'git-unstage' : 'git-stage'; heading.append(all); } host.append(heading);
    for (const change of changes) {
      const row = document.createElement('div'); row.className = 'git-file-row';
      const key = `${staged ? 'index' : 'work'}:${change.path}`;
      const inspect = this.button('', () => void this.detail(key, staged ? 'index-diff' : 'file-diff', change.path, change.path)); inspect.dataset.gitKey = key;
      const badge = document.createElement('span'); badge.className = 'git-status-badge'; badge.textContent = staged ? change.index : change.worktree === '?' ? 'U' : change.worktree;
      const name = document.createElement('span'); name.textContent = change.originalPath ? `${change.originalPath} → ${change.path}` : change.path; inspect.append(badge, name); inspect.title = change.path;
      const action = this.button(staged ? '−' : '+', () => void this.run(staged ? 'unstage-file' : 'stage-file', change.path)); action.setAttribute('aria-label', `${staged ? 'Unstage' : 'Stage'} ${change.path}`); row.append(inspect, action); host.append(row);
    }
  }
}
