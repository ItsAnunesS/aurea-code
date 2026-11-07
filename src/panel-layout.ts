export function resizePanel(handle: HTMLElement, host: HTMLElement, variable: string, storageKey: string, initial: number, min: number, max: () => number, axis: 'x' | 'y') {
  const saved = Number(localStorage.getItem(storageKey) ?? initial);
  let value = Number.isFinite(saved) ? saved : initial;
  const apply = (next: number) => {
    value = Math.max(min, Math.min(max(), next));
    host.style.setProperty(variable, `${value}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(value)));
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(Math.round(max())));
  };
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  handle.tabIndex = 0;
  apply(value);
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const start = axis === 'x' ? event.clientX : event.clientY;
    const previous = value;
    handle.onpointermove = move => apply(previous + (axis === 'x' ? move.clientX - start : start - move.clientY));
    const finish = () => {
      handle.onpointermove = null; handle.onpointerup = null; handle.onlostpointercapture = null;
      localStorage.setItem(storageKey, String(value));
    };
    handle.onpointerup = finish; handle.onlostpointercapture = finish;
  };
  handle.onkeydown = event => {
    const increase = axis === 'x' ? 'ArrowRight' : 'ArrowUp';
    const decrease = axis === 'x' ? 'ArrowLeft' : 'ArrowDown';
    if (event.key !== increase && event.key !== decrease) return;
    event.preventDefault(); apply(value + (event.key === increase ? 20 : -20)); localStorage.setItem(storageKey, String(value));
  };
  window.addEventListener('resize', () => apply(value));
}
