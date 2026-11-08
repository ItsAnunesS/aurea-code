import { canDrop } from './explorer-transfer.mjs';
import type { FileEntry } from './types';

// Only drags created by this explorer can trigger filesystem operations.
export class ExplorerDrag {
  private source?: FileEntry[];
  private target?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  constructor(private transfer: (sources: FileEntry[], destination: string, copy: boolean) => Promise<void>, private selection: (entry: FileEntry) => FileEntry[]) {}
  private copy(event: DragEvent) { return /Mac/.test(navigator.platform) ? event.altKey : event.ctrlKey; }
  private clearTarget() {
    this.target?.classList.remove('drop-target'); this.target = undefined;
    clearTimeout(this.timer);
  }
  reset() { this.clearTarget(); this.source = undefined; }
  attachSource(node: HTMLElement, entry: FileEntry) {
    node.draggable = true;
    node.ondragstart = event => {
      if (this.busy || !event.dataTransfer) { event.preventDefault(); return; }
      this.source = this.selection(entry);
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('application/x-aurea-entry', entry.path);
      event.stopPropagation();
    };
    node.ondragend = () => this.reset();
  }
  attachTarget(node: HTMLElement, destination: string, expand?: () => void) {
    node.ondragover = event => {
      event.stopPropagation();
      if (!this.source || this.busy || !this.source.every(source => canDrop(source.path, destination, source.directory, this.copy(event)))) {
        this.clearTarget(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.copy(event) ? 'copy' : 'move';
      if (this.target !== node) {
        this.clearTarget(); this.target = node; node.classList.add('drop-target');
        if (expand) this.timer = setTimeout(expand, 650);
      }
      const tree = node.closest('#file-tree') ?? node;
      const bounds = tree.getBoundingClientRect();
      if (event.clientY < bounds.top + 28) tree.scrollTop -= 12;
      if (event.clientY > bounds.bottom - 28) tree.scrollTop += 12;
    };
    node.ondragleave = event => {
      if (!(event.relatedTarget instanceof Node) || !node.contains(event.relatedTarget)) this.clearTarget();
    };
    node.ondrop = event => {
      event.stopPropagation(); event.preventDefault();
      const source = this.source; const copy = this.copy(event); this.reset();
      if (!source || this.busy || !source.every(entry => canDrop(entry.path, destination, entry.directory, copy))) return;
      this.busy = true;
      void this.transfer(source, destination, copy).finally(() => { this.busy = false; });
    };
  }
}
