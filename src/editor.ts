import { invoke } from '@tauri-apps/api/core';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { rust } from '@codemirror/lang-rust';
import { languageFor } from './utils.mjs';

export class CodeEditor {
  view?: EditorView;
  file?: { projectId: string; path: string; original: string };
  private busy = false;
  private revision = 0;
  private conflicted = false;
  constructor(private host: HTMLElement, private changed: () => void, private report: (message: string) => void) {}
  get dirty() { return !!this.file && !!this.view && this.view.state.doc.toString() !== this.file.original; }
  async open(projectId: string, path: string) {
    const revision = ++this.revision;
    const text = await invoke<string>('read_file', { projectId, relative: path });
    if (revision !== this.revision) return;
    this.view?.destroy();
    this.file = { projectId, path, original: text };
    this.conflicted = false;
    const language = languageFor(path);
    const syntax = language === 'javascript' ? javascript({ typescript: /\.tsx?$/.test(path), jsx: /\.[jt]sx$/.test(path) }) : language === 'json' ? json() : language === 'rust' ? rust() : [];
    this.view = new EditorView({ parent: this.host, state: EditorState.create({ doc: text, extensions: [basicSetup, oneDark, syntax, EditorView.lineWrapping, keymap.of([{ key: 'Mod-s', run: () => { void this.save().catch(e => this.report(String(e))); return true; } }]), EditorView.updateListener.of(update => { if (update.docChanged) this.changed(); }), EditorView.theme({ '&': { height: '100%', backgroundColor: '#191c1f' }, '.cm-scroller': { fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: '13px' }, '.cm-gutters': { backgroundColor: '#191c1f', border: 'none' }, '.cm-content': { paddingTop: '18px' } })] }) });
    this.changed(); this.view.focus();
  }
  async save() {
    if (!this.file || !this.view || !this.dirty) return;
    const file = this.file; const content = this.view.state.doc.toString();
    await invoke('save_file', { projectId: file.projectId, relative: file.path, content, original: file.original });
    if (this.file === file) { file.original = content; this.conflicted = false; this.changed(); }
  }
  close() { this.revision++; this.view?.destroy(); this.view = undefined; this.file = undefined; this.conflicted = false; this.changed(); }
  async sync() {
    if (this.busy || !this.file || !this.view) return;
    this.busy = true; const file = this.file; const view = this.view;
    try {
      const current = await invoke<string>('read_file', { projectId: file.projectId, relative: file.path });
      if (this.file !== file || this.view !== view || current === file.original) return;
      if (this.dirty) { if (!this.conflicted) this.report('The file changed on disk. Save a copy of your changes and reopen the file to resolve the conflict.'); this.conflicted = true; return; }
      file.original = current;
      const selection = view.state.selection.main.head;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: current }, selection: { anchor: Math.min(selection, current.length) } });
      this.changed();
    } catch (error) { if (!this.conflicted) this.report(`Unable to synchronize the file: ${String(error)}`); this.conflicted = true; }
    finally { this.busy = false; }
  }
}
