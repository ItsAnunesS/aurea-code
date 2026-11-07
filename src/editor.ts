import { invoke } from '@tauri-apps/api/core';
import { EditorView, keymap } from '@codemirror/view';
import { Annotation, EditorState, type Extension } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageFor } from './languages.mjs';
import { isEnvFile } from './env-values.mjs';
import { envMask, hideEnvValues } from './env-mask';

const externalChange = Annotation.define<boolean>();
export interface EditorTab {
  id: number;
  projectId: string;
  path: string;
  original: string;
  state: EditorState;
  languageName: string;
  pinned: boolean;
  conflicted: boolean;
  scrollTop: number;
  scrollLeft: number;
}
export class CodeEditor {
  view?: EditorView;
  readonly tabs: EditorTab[] = [];
  private active?: EditorTab;
  private busy = false;
  private revision = 0;
  private nextId = 0;
  constructor(private host: HTMLElement, private changed: () => void, private report: (message: string) => void, private selectionChanged: () => void = () => {}) {}
  get file() { return this.active; }
  get languageName() { return this.active?.languageName ?? 'Plain text'; }
  isDirty(tab: EditorTab) { return tab.state.doc.toString() !== tab.original; }
  get dirty() { return !!this.active && this.isDirty(this.active); }
  get hasUnsavedChanges() { return this.tabs.some(tab => this.isDirty(tab)); }
  pin(tab = this.active) { if (tab && !tab.pinned) { tab.pinned = true; this.changed(); } }
  async open(projectId: string, path: string, pinned = false, reload = false) {
    const revision = ++this.revision;
    const existing = this.tabs.find(tab => tab.projectId === projectId && tab.path === path);
    if (existing && !reload) {
      if (pinned) existing.pinned = true;
      this.activate(existing);
      void this.sync();
      return;
    }
    const previousDocument = existing?.state.doc;
    const text = await invoke<string>('read_file', { projectId, relative: path });
    if (revision !== this.revision) return;
    const language = languageFor(path);
    let syntax: Extension = [];
    let languageName = 'Plain text';
    try {
      if (language) { syntax = await language.load(); languageName = language.name; }
    } catch (error) {
      if (revision === this.revision) this.report(`Unable to load syntax highlighting: ${String(error)}`);
    }
    if (revision !== this.revision) return;
    if (reload && existing?.state.doc !== previousDocument) throw new Error('The file was edited while reloading. Try reopening it again.');
    const tab: EditorTab = { id: ++this.nextId, projectId, path, original: text, state: EditorState.create(), languageName: isEnvFile(path) ? 'Environment' : languageName, pinned: pinned || (existing?.pinned ?? false), conflicted: false, scrollTop: 0, scrollLeft: 0 };
    tab.state = EditorState.create({ doc: text, extensions: [basicSetup, oneDark, syntax, isEnvFile(path) ? envMask : [], EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', run: () => { void this.save().catch(e => this.report(String(e))); return true; } }]),
      EditorView.updateListener.of(update => {
        tab.state = update.state;
        if (update.docChanged) {
          if (update.transactions.some(transaction => transaction.docChanged && !transaction.annotation(externalChange))) tab.pinned = true;
          this.changed();
        } else if (update.selectionSet) this.selectionChanged();
      }),
      EditorView.theme({ '&': { height: '100%', backgroundColor: '#191c1f' }, '.cm-scroller': { fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: '13px' }, '.cm-gutters': { backgroundColor: '#191c1f', border: 'none' }, '.cm-content': { paddingTop: '10px' } })] });
    const replace = existing ?? this.tabs.find(value => !value.pinned && !this.isDirty(value));
    if (replace) this.tabs.splice(this.tabs.indexOf(replace), 1, tab); else this.tabs.push(tab);
    this.activate(tab);
  }
  private activate(tab: EditorTab) {
    if (this.active === tab && this.view) { this.changed(); this.view.focus(); return; }
    this.detach();
    this.active = tab;
    this.view = new EditorView({ parent: this.host, state: tab.state });
    this.view.scrollDOM.scrollTop = tab.scrollTop;
    this.view.scrollDOM.scrollLeft = tab.scrollLeft;
    this.changed(); this.view.focus();
  }
  private detach() {
    if (this.active && this.view) {
      this.active.state = this.view.state;
      this.active.scrollTop = this.view.scrollDOM.scrollTop;
      this.active.scrollLeft = this.view.scrollDOM.scrollLeft;
    }
    this.view?.destroy(); this.view = undefined;
  }
  async save() {
    const file = this.active;
    if (!file || !this.dirty) return;
    const content = file.state.doc.toString();
    await invoke('save_file', { projectId: file.projectId, relative: file.path, content, original: file.original });
    if (this.tabs.includes(file)) { file.original = content; file.conflicted = false; this.changed(); }
  }
  async reload() {
    if (this.active) await this.open(this.active.projectId, this.active.path, this.active.pinned, true);
  }
  closeTab(tab: EditorTab) {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.revision++;
    this.tabs.splice(index, 1);
    if (this.active === tab) {
      this.detach(); this.active = undefined;
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) { this.activate(next); void this.sync(); return; }
    }
    this.changed();
  }
  close() { this.revision++; this.detach(); this.active = undefined; this.tabs.length = 0; this.changed(); }
  async sync() {
    if (this.busy || !this.active || !this.view) return;
    this.busy = true; const file = this.active; const view = this.view;
    try {
      const current = await invoke<string>('read_file', { projectId: file.projectId, relative: file.path });
      if (this.active !== file || this.view !== view || current === file.original) return;
      if (this.isDirty(file)) { if (!file.conflicted) this.report('The file changed on disk. Save a copy of your changes and reopen the file to resolve the conflict.'); file.conflicted = true; return; }
      file.original = current;
      const selection = view.state.selection.main.head;
      view.dispatch({ annotations: externalChange.of(true), effects: hideEnvValues.of(null), changes: { from: 0, to: view.state.doc.length, insert: current }, selection: { anchor: Math.min(selection, current.length) } });
      this.changed();
    } catch (error) { if (!file.conflicted) this.report(`Unable to synchronize the file: ${String(error)}`); file.conflicted = true; }
    finally { this.busy = false; }
  }
}
