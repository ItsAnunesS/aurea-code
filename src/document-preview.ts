import { documentKind, renderDocument } from './document-renderer.mjs';

type Mode = 'code' | 'split' | 'preview';
export class DocumentPreview {
  private mode: Mode = 'code';
  private file = '';
  private timer = 0;
  private source = '';
  constructor(private host: HTMLElement, private code: HTMLElement, private controls: HTMLElement, private resize: () => void) {
    controls.querySelectorAll<HTMLButtonElement>('[data-document-mode]').forEach(button => {
      button.onclick = () => { this.mode = button.dataset.documentMode as Mode; this.layout(); this.render(); };
    });
  }
  update(file: string, source: string) {
    const changedFile = file !== this.file;
    const changedText = source !== this.source;
    this.file = file; this.source = source;
    if (changedFile) { this.mode = 'code'; this.host.replaceChildren(); this.host.scrollTop = 0; }
    this.layout();
    if (changedFile || changedText) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.render(), 150);
    }
  }
  private layout() {
    const enabled = !!documentKind(this.file);
    this.controls.hidden = !enabled;
    this.host.hidden = !enabled || this.mode === 'code';
    this.code.hidden = !this.file || (enabled && this.mode === 'preview');
    this.controls.querySelectorAll<HTMLButtonElement>('[data-document-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.documentMode === this.mode)));
    this.resize();
  }
  private render() {
    if (!this.host.hidden) this.host.innerHTML = renderDocument(this.file, this.source);
  }
}
