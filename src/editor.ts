import { movedPath } from './explorer-transfer.mjs';
import { mediaType } from './media-types.mjs';
import { invoke } from '@tauri-apps/api/core';
import { EditorView, keymap } from '@codemirror/view';
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { editorAppearance } from './editor-theme';
import { languageFor } from './languages.mjs';
import { isEnvFile } from './env-values.mjs';
import { envMask, hideEnvValues } from './env-mask';

const externalChange = Annotation.define<boolean>();
const mirroredChange = Annotation.define<boolean>();
export interface EditorTab {
  id: number; projectId: string; path: string; original: string; state: EditorState;
  languageName: string; pinned: boolean; conflicted: boolean; scrollTop: number; scrollLeft: number;
  media: string | null; bytes?: Uint8Array; syntax: Compartment; masking: Compartment;
}
export interface EditorGroup { host: HTMLElement; tabs: EditorTab[]; active?: EditorTab; view?: EditorView }
export class CodeEditor {
  readonly groups: EditorGroup[];
  activeGroup = 0;
  private busy = false;
  private transferring = false;
  private saving = false;
  private revisions = [0, 0];
  private nextId = 0;
  constructor(host: HTMLElement, private changed: () => void, private report: (message: string) => void, private selectionChanged: () => void = () => {}, secondHost?: HTMLElement) {
    this.groups = [{ host, tabs: [] }, ...(secondHost ? [{ host: secondHost, tabs: [] }] : [])];
  }
  get tabs() { return [...new Set(this.groups.flatMap(group => group.tabs))]; }
  get file() { return this.groups[this.activeGroup].active; }
  get view() { return this.groups[this.activeGroup].view; }
  get languageName() { return this.file?.languageName ?? 'Plain text'; }
  isDirty(tab: EditorTab) { return !this.isBinary(tab) && tab.state.doc.toString() !== tab.original; }
  isBinary(tab: EditorTab) { return !!tab.media && tab.media !== 'image/svg+xml'; }
  get dirty() { return !!this.file && this.isDirty(this.file); }
  get hasUnsavedChanges() { return this.tabs.some(tab => this.isDirty(tab)); }
  pin(tab = this.file) { if (tab && !tab.pinned) { tab.pinned = true; this.changed(); } }
  focusGroup(index: number) { if (this.activeGroup !== index) { this.activeGroup = index; this.changed(); } }
  async open(projectId: string, path: string, pinned = false, reload = false, groupIndex = this.activeGroup) {
    if (this.transferring) throw new Error('Wait for the file operation before opening a file.');
    const revision = ++this.revisions[groupIndex];
    const existing = this.tabs.find(tab => tab.projectId === projectId && tab.path === path);
    if (existing && !reload) {
      if (pinned) existing.pinned = true;
      this.place(existing, groupIndex); this.activate(existing, groupIndex); void this.sync(); return;
    }
    const previousDocument = existing?.state.doc;
    const media = mediaType(path);
    const binary = media && media !== 'image/svg+xml';
    const bytes = binary ? new Uint8Array(await invoke<ArrayBuffer>('read_media', { projectId, relative: path })) : undefined;
    const text = binary ? '' : await invoke<string>('read_file', { projectId, relative: path });
    if (revision !== this.revisions[groupIndex]) return;
    const language = languageFor(path, text);
    let syntax: Extension = [];
    let languageName = binary ? (media === 'application/pdf' ? 'PDF' : 'Image') : 'Plain text';
    try { if (language && !binary) { syntax = await language.load(); languageName = language.name; } }
    catch (error) { if (revision === this.revisions[groupIndex]) this.report(`Unable to load syntax highlighting: ${String(error)}`); }
    if (revision !== this.revisions[groupIndex]) return;
    if (reload && existing?.state.doc !== previousDocument) throw new Error('The file was edited while reloading. Try again.');
    const tab: EditorTab = { id: ++this.nextId, projectId, path, original: text, state: EditorState.create(), languageName: isEnvFile(path) ? 'Environment' : languageName, pinned: pinned || (existing?.pinned ?? false), conflicted: false, scrollTop: 0, scrollLeft: 0, media, bytes, syntax: new Compartment(), masking: new Compartment() };
    tab.state = EditorState.create({ doc: text, extensions: [basicSetup, editorAppearance(), tab.syntax.of(syntax), tab.masking.of(isEnvFile(path) ? envMask : []), EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', run: () => { void this.save().catch(e => this.report(String(e))); return true; } }]),
      EditorView.domEventHandlers({ focus: (_event, view) => { const index = this.groups.findIndex(group => group.view === view); if (index >= 0) this.focusGroup(index); } }),
      EditorView.updateListener.of(update => {
        if (update.transactions.some(transaction => transaction.annotation(mirroredChange))) return;
        tab.state = update.state;
        if (update.docChanged) {
          if (update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalChange))) tab.pinned = true;
          for (const group of this.groups) if (group.active === tab && group.view && group.view !== update.view) {
            group.view.dispatch({ changes: update.changes, annotations: [mirroredChange.of(true), Transaction.addToHistory.of(false)] });
          }
          this.changed();
        } else if (update.selectionSet) this.selectionChanged();
      }),
      EditorView.theme({ '&': { height: '100%', backgroundColor: 'var(--canvas)' }, '.cm-scroller': { fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: '13px' }, '.cm-gutters': { backgroundColor: 'var(--canvas)', border: 'none' }, '.cm-content': { paddingTop: '10px' } })] });
    if (existing) {
      for (const [index, group] of this.groups.entries()) {
        const position = group.tabs.indexOf(existing);
        if (position >= 0) group.tabs.splice(position, 1, tab);
        if (group.active === existing) this.activate(tab, index, false);
      }
    }
    this.place(tab, groupIndex); this.activate(tab, groupIndex);
  }
  private place(tab: EditorTab, index: number) {
    const group = this.groups[index];
    if (group.tabs.includes(tab)) return;
    const replace = group.tabs.find(value => !value.pinned && !this.isDirty(value));
    if (replace) group.tabs.splice(group.tabs.indexOf(replace), 1, tab); else group.tabs.push(tab);
  }
  private activate(tab: EditorTab, index: number, focus = true) {
    const group = this.groups[index];
    if (group.active !== tab) {
      this.detach(group); group.active = tab;
      if (!this.isBinary(tab)) {
        group.view = new EditorView({ parent: group.host, state: tab.state });
        group.view.scrollDOM.scrollTop = tab.scrollTop; group.view.scrollDOM.scrollLeft = tab.scrollLeft;
      }
    }
    if (focus) this.activeGroup = index;
    this.changed(); if (focus) group.view?.focus();
  }
  private detach(group: EditorGroup) {
    if (group.active && group.view) {
      group.active.state = group.view.state;
      group.active.scrollTop = group.view.scrollDOM.scrollTop; group.active.scrollLeft = group.view.scrollDOM.scrollLeft;
    }
    group.view?.destroy(); group.view = undefined;
  }
  split(tab = this.file) {
    if (!tab || this.groups.length < 2) return;
    tab.pinned = true;
    this.place(tab, 1); this.activate(tab, 1);
  }
  reorder(tab: EditorTab, from: number, to: number, before?: EditorTab) {
    if (from === to && before === tab) return;
    tab.pinned = true;
    const source = this.groups[from], target = this.groups[to];
    source.tabs = source.tabs.filter(value => value !== tab);
    target.tabs = target.tabs.filter(value => value !== tab);
    const position = before ? target.tabs.indexOf(before) : target.tabs.length;
    target.tabs.splice(position < 0 ? target.tabs.length : position, 0, tab);
    if (from !== to && source.active === tab) {
      this.detach(source); source.active = undefined;
      if (source.tabs.length) this.activate(source.tabs[0], from, false);
    }
    this.activate(tab, to);
  }
  closeGroup() {
    const secondary = this.groups[1]; if (!secondary) return;
    for (const tab of secondary.tabs) if (!this.groups[0].tabs.includes(tab)) this.groups[0].tabs.push(tab);
    const active = secondary.active; this.detach(secondary); secondary.active = undefined; secondary.tabs = [];
    this.activeGroup = 0;
    if (active) this.activate(active, 0); else this.changed();
  }
  async transfer(projectId: string, source: string, destination: string, copy: boolean) {
    return this.mutate(projectId, source, () => invoke<string>('transfer_entry', { projectId, source, destination, copy }), !copy);
  }
  async rename(projectId: string, source: string, name: string) {
    return this.mutate(projectId, source, () => invoke<string>('rename_entry', { projectId, source, name }), true);
  }
  async delete(projectId: string, source: string) {
    if (this.transferring || this.saving) throw new Error('Wait for the current file operation to finish.');
    const affected = this.tabs.filter(tab => tab.projectId === projectId && movedPath(tab.path, source, '') !== tab.path);
    if (affected.some(tab => this.isDirty(tab))) throw new Error('Save or close unsaved files in this selection before deleting.');
    this.transferring = true; this.revisions = this.revisions.map(value => value + 1);
    try {
      await invoke('delete_entry', { projectId, relative: source });
      for (const tab of affected) {
        if (this.isDirty(tab)) { this.report(`Deleted ${tab.path} from disk; edits made during deletion remain open. Copy them to a new file to keep them.`); continue; }
        this.groups.forEach((_, index) => this.closeTab(tab, index));
      }
    } finally { this.transferring = false; }
  }
  private async mutate(projectId: string, source: string, operation: () => Promise<string>, remap: boolean) {
    if (this.transferring || this.saving) throw new Error('Wait for the current save or transfer to finish.');
    this.transferring = true; this.revisions = this.revisions.map(value => value + 1);
    try {
      const path = await operation();
      if (remap) {
        for (const tab of this.tabs) if (tab.projectId === projectId) {
          const next = movedPath(tab.path, source, path);
          if (next !== tab.path) { tab.path = next; await this.refreshLanguage(tab); }
        }
        this.changed();
      }
      return path;
    } finally { this.transferring = false; }
  }
  private async refreshLanguage(tab: EditorTab) {
    if (this.isBinary(tab)) return;
    const language = languageFor(tab.path, tab.state.doc.toString());
    let syntax: Extension = [];
    try { if (language) syntax = await language.load(); }
    catch (error) { this.report(`Unable to load syntax highlighting: ${String(error)}`); }
    tab.media = mediaType(tab.path) === 'image/svg+xml' ? 'image/svg+xml' : null;
    tab.languageName = isEnvFile(tab.path) ? 'Environment' : language?.name ?? 'Plain text';
    const effects = [tab.syntax.reconfigure(syntax), tab.masking.reconfigure(isEnvFile(tab.path) ? envMask : [])];
    tab.state = tab.state.update({ effects }).state;
    for (const group of this.groups) if (group.active === tab) group.view?.dispatch({ effects });
  }
  async save() {
    if (this.transferring || this.saving) throw new Error('Wait for the current save or transfer to finish.');
    const file = this.file; if (!file || !this.isDirty(file)) return;
    const content = file.state.doc.toString(); this.saving = true;
    try {
      await invoke('save_file', { projectId: file.projectId, relative: file.path, content, original: file.original });
      if (this.tabs.includes(file)) { file.original = content; file.conflicted = false; this.changed(); }
    } finally { this.saving = false; }
  }
  async reload() { if (this.file) await this.open(this.file.projectId, this.file.path, this.file.pinned, true); }
  closeTab(tab: EditorTab, groupIndex = this.activeGroup) {
    const group = this.groups[groupIndex], index = group.tabs.indexOf(tab); if (index < 0) return;
    this.revisions[groupIndex]++; group.tabs.splice(index, 1);
    if (group.active === tab) {
      this.detach(group); group.active = undefined;
      const next = group.tabs[Math.min(index, group.tabs.length - 1)];
      if (next) this.activate(next, groupIndex);
    }
    if (!group.tabs.length && groupIndex === 1) this.activeGroup = 0;
    this.changed();
  }
  close() {
    this.revisions = this.revisions.map(value => value + 1);
    for (const group of this.groups) { this.detach(group); group.active = undefined; group.tabs = []; }
    this.activeGroup = 0; this.changed();
  }
  async sync() {
    if (this.transferring || this.busy) return;
    this.busy = true;
    try {
      for (const file of new Set(this.groups.map(group => group.active))) {
        if (!file || this.isBinary(file)) continue;
        const path = file.path;
        try {
          const current = await invoke<string>('read_file', { projectId: file.projectId, relative: path });
          if (this.transferring || file.path !== path || !this.groups.some(group => group.active === file) || current === file.original) continue;
          if (this.isDirty(file)) { if (!file.conflicted) this.report('The file changed on disk. Reopen it to resolve the conflict.'); file.conflicted = true; continue; }
          file.original = current;
          const view = this.groups.find(group => group.active === file)?.view;
          if (view) view.dispatch({ annotations: externalChange.of(true), effects: hideEnvValues.of(null), changes: { from: 0, to: view.state.doc.length, insert: current }, selection: { anchor: Math.min(view.state.selection.main.head, current.length) } });
          this.changed();
        } catch (error) { if (this.transferring || file.path !== path) continue; if (!file.conflicted) this.report(`Unable to synchronize the file: ${String(error)}`); file.conflicted = true; }
      }
    } finally { this.busy = false; }
  }
}
