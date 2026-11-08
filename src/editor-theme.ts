import { Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { resolvedAppearance } from './appearance';

export function editorAppearance() {
  const compartment = new Compartment();
  const theme = () => resolvedAppearance() === 'dark' ? oneDark : [syntaxHighlighting(defaultHighlightStyle), EditorView.theme({}, { dark: false })];
  return [compartment.of(theme()), ViewPlugin.fromClass(class {
    private timer: ReturnType<typeof setTimeout>;
    private refresh = () => this.view.dispatch({ effects: compartment.reconfigure(theme()) });
    constructor(private view: EditorView) {
      window.addEventListener('appearancechange', this.refresh);
      // A background tab may hold a state created under the previous appearance.
      this.timer = setTimeout(this.refresh, 0);
    }
    destroy() { clearTimeout(this.timer); window.removeEventListener('appearancechange', this.refresh); }
  })];
}
