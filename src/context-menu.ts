export interface MenuAction { label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run: () => void }
let dismiss: (() => void) | undefined;
export function showContextMenu(x: number, y: number, actions: MenuAction[], restore?: HTMLElement) {
  dismiss?.();
  const menu = document.createElement('div'); menu.className = 'context-menu'; menu.setAttribute('role', 'menu');
  const close = (focus = false) => { menu.remove(); dismiss = undefined; document.removeEventListener('pointerdown', outside, true); if (focus) restore?.focus(); };
  dismiss = () => close();
  const outside = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
  for (const action of actions) {
    const button = document.createElement('button'); button.setAttribute('role', action.checked === undefined ? 'menuitem' : 'menuitemradio'); if (action.checked !== undefined) button.setAttribute('aria-checked', String(action.checked)); button.disabled = !!action.disabled;
    const label = document.createElement('span'); label.textContent = action.label; button.append(label);
    if (action.shortcut) { const key = document.createElement('kbd'); key.textContent = action.shortcut; button.append(key); }
    button.onclick = () => { close(true); action.run(); }; menu.append(button);
  }
  menu.onkeydown = event => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(true); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };
  document.body.append(menu);
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  document.addEventListener('pointerdown', outside, true);
}
