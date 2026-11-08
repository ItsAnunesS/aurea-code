import type { FileEntry } from './types';
import { normalizePath, selectedRange, topLevelEntries } from './explorer-transfer.mjs';
import { showContextMenu } from './context-menu';

interface ExplorerActions {
  transfer: (entries: FileEntry[], destination: string, copy: boolean) => Promise<void>;
  delete: (entries: FileEntry[]) => void;
  rename: (entry: FileEntry) => void;
  create: (parent: string, folder: boolean) => void;
  open: (entry: FileEntry, side: boolean) => void;
  report: (message: string) => void;
}
export class ExplorerSelection {
  private selected = new Map<string, FileEntry>();
  private anchor = '';
  private clipboard?: { project: string; entries: FileEntry[]; copy: boolean };
  private project = '';
  private pasting = false;
  constructor(private root: HTMLElement, private actions: ExplorerActions) {
    const tree = root.querySelector('#file-tree'); tree?.setAttribute('role', 'tree'); tree?.setAttribute('aria-multiselectable', 'true');
    root.tabIndex = 0; root.setAttribute('aria-label', 'Project files');
    root.addEventListener('click', event => { if ((event.target as HTMLElement).matches('#explorer-root, #file-tree')) { this.selected.clear(); this.anchor = ''; this.paint(); root.focus(); } });
    root.onkeydown = event => this.keydown(event);
    root.oncontextmenu = event => { if (!(event.target as HTMLElement).closest('[data-entry-path]')) { event.preventDefault(); this.selected.clear(); this.paint(); this.menu(event.clientX, event.clientY, ''); } };
  }
  activate(project: string) { if (project !== this.project) { this.selected.clear(); this.clipboard = undefined; this.anchor = ''; this.project = project; } }
  entries() { return topLevelEntries([...this.selected.values()]) as FileEntry[]; }
  forDrag(entry: FileEntry) { if (!this.selected.has(entry.path)) this.selectOnly(entry); return this.entries(); }
  selectOnly(entry: FileEntry) { this.selected.clear(); this.selected.set(entry.path, entry); this.anchor = entry.path; this.paint(); }
  private rows() { return [...this.root.querySelectorAll<HTMLElement>('[data-entry-path]')].filter(node => node.getClientRects().length > 0); }
  private entry(node: HTMLElement): FileEntry { return { path: node.dataset.entryPath!, name: node.dataset.entryPath!.split(/[\\/]/).pop()!, directory: node.dataset.directory === 'true' }; }
  attach(node: HTMLElement, entry: FileEntry) {
    node.setAttribute('role', 'treeitem'); node.dataset.entryPath = entry.path; node.dataset.directory = String(entry.directory);
    node.oncontextmenu = event => { event.preventDefault(); event.stopPropagation(); if (!this.selected.has(entry.path)) this.selectOnly(entry); this.menu(event.clientX, event.clientY, entry.directory ? entry.path : this.parent(entry.path), node); };
    this.paintNode(node);
  }
  click(event: MouseEvent, entry: FileEntry) {
    if (event.shiftKey) {
      if (!(event.ctrlKey || event.metaKey)) this.selected.clear();
      const rows = this.rows();
      for (const path of selectedRange(rows.map(row => row.dataset.entryPath!), this.anchor, entry.path)) {
        const row = rows.find(row => row.dataset.entryPath === path); if (row) this.selected.set(path, this.entry(row));
      }
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selected.has(entry.path)) this.selected.delete(entry.path); else this.selected.set(entry.path, entry);
      this.anchor = entry.path;
    } else this.selectOnly(entry);
    this.paint(); return !(event.shiftKey || event.ctrlKey || event.metaKey);
  }
  private parent(path: string) { return normalizePath(path).split('/').slice(0, -1).join('/'); }
  currentFolder() { return this.destination(); }
  private destination() { const last = [...this.selected.values()].at(-1); return last ? last.directory ? last.path : this.parent(last.path) : ''; }
  private paintNode(node: HTMLElement) {
    node.classList.toggle('selected', this.selected.has(node.dataset.entryPath!));
    node.classList.toggle('cut-entry', !!this.clipboard && !this.clipboard.copy && this.clipboard.entries.some(entry => entry.path === node.dataset.entryPath));
    node.setAttribute('aria-selected', String(this.selected.has(node.dataset.entryPath!)));
  }
  paint() { this.root.querySelectorAll<HTMLElement>('[data-entry-path]').forEach(node => this.paintNode(node)); }
  remap(_source: string, destination: string) { this.selected.clear(); this.anchor = destination; this.clipboard = undefined; this.paint(); }
  copy(copy: boolean) {
    const entries = this.entries(); if (!entries.length) return;
    this.clipboard = { project: this.project, entries, copy }; this.paint();
    this.actions.report(`${entries.length} item(s) ${copy ? 'copied' : 'cut'}. Select a folder and paste.`);
  }
  private async paste(destination: string) {
    const clipboard = this.clipboard;
    if (!clipboard || clipboard.project !== this.project || this.pasting) return;
    this.pasting = true;
    try {
      await this.actions.transfer(clipboard.entries, destination, clipboard.copy);
      if (!clipboard.copy && this.clipboard === clipboard) this.clipboard = undefined;
    } catch (error) { this.actions.report(String(error)); }
    finally { this.pasting = false; this.paint(); }
  }
  private menu(x: number, y: number, destination: string, restore = this.root) {
    const entries = this.entries(); const single = entries.length === 1 ? entries[0] : undefined;
    showContextMenu(x, y, [
      { label: 'Open', disabled: !single || single.directory, run: () => single && this.actions.open(single, false) },
      { label: 'Open to the Side', disabled: !single || single.directory, run: () => single && this.actions.open(single, true) },
      { label: 'New File…', run: () => this.actions.create(destination, false) },
      { label: 'New Folder…', run: () => this.actions.create(destination, true) },
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !entries.length, run: () => this.copy(false) },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !entries.length, run: () => this.copy(true) },
      { label: 'Paste', shortcut: 'Ctrl+V', disabled: !this.clipboard || this.pasting, run: () => void this.paste(destination) },
      { label: 'Delete…', shortcut: 'Delete', disabled: !entries.length, run: () => this.actions.delete(entries) },
      { label: 'Rename…', shortcut: 'F2', disabled: !single, run: () => single && this.actions.rename(single) },
    ], restore);
  }
  private keydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement).matches('input,textarea,[contenteditable=true]')) return;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    const entries = this.entries();
    if (mod && ['c', 'x', 'v', 'a'].includes(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === 'a') { this.selected.clear(); for (const row of this.rows()) this.selected.set(row.dataset.entryPath!, this.entry(row)); this.paint(); }
      else if (key === 'v') void this.paste(this.destination()); else this.copy(key === 'c');
    } else if (event.key === 'F2' && entries.length === 1) { event.preventDefault(); this.actions.rename(entries[0]); }
    else if (event.key === 'Delete' && entries.length && !mod && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); this.actions.delete(entries); }
    else if (event.key === 'Escape') { this.clipboard = undefined; this.selected.clear(); this.paint(); }
    else if (event.key === 'Enter' && entries.length === 1 && !entries[0].directory) { event.preventDefault(); this.actions.open(entries[0], mod); }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault(); const node = document.activeElement as HTMLElement; const bounds = node.getBoundingClientRect(); this.menu(bounds.left, bounds.bottom, this.destination(), node);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const rows = this.rows(); const index = rows.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      const row = rows[next]; if (row) { this.click(event as unknown as MouseEvent, this.entry(row)); row.focus(); }
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const node = document.activeElement as HTMLElement; const details = node.closest('details');
      if (details) { event.preventDefault(); details.open = event.key === 'ArrowRight'; }
    }
  }
}
