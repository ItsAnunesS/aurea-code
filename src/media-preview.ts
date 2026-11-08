/// <reference types="vite/client" />
import type { EditorTab } from './editor';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export class MediaPreview {
  private key = '';
  private source = '';
  private revision = 0;
  private url?: string;
  private loading?: PDFDocumentLoadingTask;
  private pdf?: PDFDocumentProxy;
  private renderTask?: RenderTask;
  private page = 1;
  private scale = 1;
  private renderRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private image?: HTMLImageElement;
  private viewport: HTMLElement;
  private label: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  constructor(private host: HTMLElement) {
    const toolbar = document.createElement('div'); toolbar.className = 'media-toolbar';
    const button = (title: string, action: () => void) => { const node = document.createElement('button'); node.textContent = title; node.onclick = action; toolbar.append(node); return node; };
    this.previous = button('Previous page', () => { this.page--; void this.renderPage(); });
    this.label = document.createElement('span'); this.label.setAttribute('role', 'status'); toolbar.append(this.label);
    this.next = button('Next page', () => { this.page++; void this.renderPage(); });
    button('−', () => this.zoom(-.25)).setAttribute('aria-label', 'Zoom out');
    button('+', () => this.zoom(.25)).setAttribute('aria-label', 'Zoom in');
    button('Fit', () => { this.scale = 1; if (this.pdf) void this.renderPage(); else this.fitImage(); });
    this.viewport = document.createElement('div'); this.viewport.className = 'media-viewport';
    host.append(toolbar, this.viewport);
  }
  update(tab?: EditorTab) {
    const key = tab?.media ? String(tab.id) : '';
    const source = tab?.media === 'image/svg+xml' ? tab.state.doc.toString() : '';
    this.host.hidden = !key;
    if (key === this.key && source === this.source) return;
    this.key = key; this.source = source; this.revision++;
    clearTimeout(this.timer);
    this.renderTask?.cancel(); this.renderTask = undefined;
    void this.loading?.destroy().catch(() => {}); this.loading = undefined; this.pdf = undefined;
    if (this.url) URL.revokeObjectURL(this.url); this.url = undefined; this.image = undefined;
    this.viewport.replaceChildren(); this.page = 1; this.scale = 1;
    if (!tab?.media) return;
    this.previous.hidden = this.next.hidden = tab.media !== 'application/pdf';
    this.label.textContent = 'Loading preview…';
    const revision = this.revision;
    if (tab.media === 'application/pdf') void this.loadPdf(tab, revision);
    else this.timer = setTimeout(() => {
      if (revision !== this.revision) return;
      // SVG is an image document, never inserted into the privileged application DOM.
      this.url = URL.createObjectURL(new Blob([tab.media === 'image/svg+xml' ? source : new Uint8Array(tab.bytes!)], { type: tab.media! }));
      const image = document.createElement('img'); image.alt = tab.path; image.src = this.url; this.image = image;
      image.onload = () => { if (revision !== this.revision) return; this.fitImage(); };
      image.onerror = () => { if (revision === this.revision) this.label.textContent = 'Unable to decode this image. The format may not be supported by your system.'; };
      this.viewport.append(image);
    }, tab.media === 'image/svg+xml' ? 150 : 0);
  }
  private fitImage() {
    if (!this.image) return;
    this.image.style.width = this.scale === 1 ? '' : `${this.image.naturalWidth * this.scale}px`;
    this.image.style.maxWidth = this.scale === 1 ? '100%' : 'none';
    this.image.style.maxHeight = this.scale === 1 ? '100%' : 'none';
    this.label.textContent = `${this.image.naturalWidth} × ${this.image.naturalHeight} · ${this.scale === 1 ? 'Fit' : `${Math.round(this.scale * 100)}%`}`;
  }
  private zoom(delta: number) { this.scale = Math.min(4, Math.max(.25, this.scale + delta)); if (this.pdf) void this.renderPage(); else this.fitImage(); }
  private async loadPdf(tab: EditorTab, revision: number) {
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      if (revision !== this.revision) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const loading = pdfjs.getDocument({ data: new Uint8Array(tab.bytes!), disableWorkerRendering: true, useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 16_000_000, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
      this.loading = loading; const pdf = await loading.promise;
      if (revision !== this.revision) return;
      this.pdf = pdf; await this.renderPage();
    } catch (error) { if (revision === this.revision) this.label.textContent = `Unable to preview PDF: ${String(error)}`; }
  }
  private async renderPage() {
    const pdf = this.pdf; if (!pdf) return;
    const revision = ++this.renderRevision;
    this.renderTask?.cancel();
    this.page = Math.max(1, Math.min(pdf.numPages, this.page));
    this.previous.disabled = this.page === 1; this.next.disabled = this.page === pdf.numPages;
    this.label.textContent = `Page ${this.page} / ${pdf.numPages} · ${Math.round(this.scale * 100)}%`;
    try {
      const page = await pdf.getPage(this.page);
      if (pdf !== this.pdf || revision !== this.renderRevision) return;
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(1.5, Math.max(200, this.host.clientWidth - 40) / base.width);
      const scale = Math.min(fit * this.scale * Math.min(devicePixelRatio, 2), Math.sqrt(12_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / Math.min(devicePixelRatio, 2)}px`;
      canvas.setAttribute('aria-label', `PDF page ${this.page}`);
      this.viewport.replaceChildren(canvas);
      this.renderTask = page.render({ canvas, viewport }); await this.renderTask.promise;
      if (revision === this.renderRevision) canvas.dataset.rendered = 'true';
    } catch (error) { if (pdf === this.pdf && revision === this.renderRevision && (error as Error).name !== 'RenderingCancelledException') this.label.textContent = `Unable to render page: ${String(error)}`; }
  }
}
