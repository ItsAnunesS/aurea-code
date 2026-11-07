import { fileIconMarkup } from './file-icons.mjs';

export interface QuickItem { label: string; detail: string; path?: string; run: () => Promise<unknown> | unknown }
export class QuickAccess {
  private dialog = document.createElement('dialog');
  private input: HTMLInputElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private items: QuickItem[] = [];
  private filtered: QuickItem[] = [];
  private selected = 0;
  private revision = 0;
  private controller?: AbortController;
  private previousFocus?: HTMLElement;
  constructor(private report: (message: string) => void) {
    this.dialog.id = 'quick-access';
    this.dialog.setAttribute('aria-label', 'Quick access');
    this.dialog.innerHTML = '<div class="quick-search"><input id="quick-input" autocomplete="off" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="quick-results" aria-autocomplete="list"><kbd>esc</kbd></div><p id="quick-status" role="status"></p><div id="quick-results" role="listbox" aria-label="Results"></div><footer><span>↑ ↓ to navigate</span><span>↵ to open</span></footer>';
    document.body.append(this.dialog);
    this.input = this.dialog.querySelector('input')!;
    this.list = this.dialog.querySelector('#quick-results')!;
    this.status = this.dialog.querySelector('#quick-status')!;
    this.input.oninput = () => { this.selected = 0; this.render(); };
    this.input.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + (event.key === 'ArrowDown' ? 1 : -1)));
        this.render();
      } else if (event.key === 'Enter') { event.preventDefault(); void this.choose(this.selected); }
    };
    this.dialog.onclose = () => { this.revision++; this.controller?.abort(); this.previousFocus?.focus(); };
    this.dialog.onclick = event => { if (event.target === this.dialog) this.dialog.close(); };
  }
  async open(placeholder: string, load: (signal: AbortSignal) => Promise<{ items: QuickItem[]; note?: string }>) {
    this.controller?.abort();
    this.controller = new AbortController();
    this.previousFocus = document.activeElement as HTMLElement;
    const revision = ++this.revision;
    this.items = []; this.selected = 0; this.input.value = ''; this.input.placeholder = placeholder;
    this.status.textContent = 'Loading…'; this.list.replaceChildren();
    this.input.removeAttribute('aria-activedescendant');
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
    try {
      const result = await load(this.controller.signal);
      if (revision !== this.revision || !this.dialog.open) return;
      this.items = result.items; this.status.textContent = result.note ?? 'Choose a result';
      this.render();
    } catch (error) {
      if (revision === this.revision) this.status.textContent = String(error);
    }
  }
  private render() {
    const query = this.input.value.toLowerCase().trim();
    this.filtered = this.items.filter(item => (item.label + ' ' + item.detail).toLowerCase().includes(query)).slice(0, 80);
    this.list.replaceChildren();
    this.input.removeAttribute('aria-activedescendant');
    if (!this.filtered.length) {
      const empty = document.createElement('p'); empty.className = 'quick-empty'; empty.textContent = 'No matches. Try another name.'; this.list.append(empty);
    }
    this.filtered.forEach((item, index) => {
      const row = document.createElement('button'); row.type = 'button'; row.id = `quick-result-${index}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === this.selected));
      row.tabIndex = -1;
      if (item.path) row.innerHTML = fileIconMarkup(item.path);
      const label = document.createElement('span'); label.textContent = item.label;
      const detail = document.createElement('small'); detail.textContent = item.detail;
      row.append(label, detail); row.onclick = () => void this.choose(index); this.list.append(row);
      if (index === this.selected) this.input.setAttribute('aria-activedescendant', row.id);
    });
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }
  private async choose(index: number) {
    const item = this.filtered[index]; if (!item) return;
    this.dialog.close();
    try { await item.run(); } catch (error) { this.report(String(error)); }
  }
}
