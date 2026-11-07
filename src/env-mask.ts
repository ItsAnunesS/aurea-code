import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { envValues } from './env-values.mjs';

const toggleValue = StateEffect.define<number>();
export const hideEnvValues = StateEffect.define<null>();

class ValueToggle extends WidgetType {
  constructor(readonly from: number, readonly name: string, readonly revealed: boolean) { super(); }
  eq(other: ValueToggle) { return this.from === other.from && this.name === other.name && this.revealed === other.revealed; }
  toDOM(view: EditorView) {
    const button = document.createElement('button');
    button.className = 'env-value-toggle';
    button.type = 'button';
    button.setAttribute('aria-label', `${this.revealed ? 'Hide' : 'Reveal'} value for ${this.name}`);
    button.setAttribute('aria-pressed', String(this.revealed));
    button.title = `${this.revealed ? 'Hide' : 'Reveal'} value`;
    button.innerHTML = `${this.revealed ? '' : '<span aria-hidden="true">••••••••</span>'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${this.revealed ? '<path d="m3 3 18 18"/>' : ''}</svg>`;
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => view.dispatch({ effects: toggleValue.of(this.from) });
    return button;
  }
  ignoreEvent() { return true; }
}

export const envMask = StateField.define<{ revealed: Set<number>; decorations: DecorationSet }>({
  create(state) { return build(state.doc.toString(), new Set()); },
  update(value, transaction) {
    let revealed = value.revealed;
    if (transaction.docChanged) revealed = new Set([...revealed].map(position => transaction.changes.mapPos(position, -1)));
    for (const effect of transaction.effects) {
      if (effect.is(hideEnvValues)) revealed = new Set();
      if (effect.is(toggleValue)) {
        revealed = new Set(revealed);
        if (revealed.has(effect.value)) revealed.delete(effect.value); else revealed.add(effect.value);
      }
    }
    return transaction.docChanged || revealed !== value.revealed ? build(transaction.state.doc.toString(), revealed) : value;
  },
  provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).decorations)],
});

function build(text: string, revealed: Set<number>) {
  const values = envValues(text);
  const active = new Set(values.filter(value => revealed.has(value.from)).map(value => value.from));
  return { revealed: active, decorations: Decoration.set(values.map(value => {
    const visible = active.has(value.from);
    const widget = new ValueToggle(value.from, value.name, visible);
    return visible ? Decoration.widget({ widget, side: -1 }).range(value.from) : Decoration.replace({ widget }).range(value.from, value.to);
  }), true) };
}
