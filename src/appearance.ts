export type Appearance = 'system' | 'light' | 'dark';
const preference = matchMedia('(prefers-color-scheme: dark)');
export function appearance(): Appearance {
  const stored = localStorage.getItem('aurea.appearance');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}
export function resolvedAppearance() { return appearance() === 'system' ? preference.matches ? 'dark' : 'light' : appearance(); }
function apply() {
  document.documentElement.dataset.appearance = resolvedAppearance();
  document.documentElement.style.colorScheme = resolvedAppearance();
  window.dispatchEvent(new Event('appearancechange'));
}
export function setAppearance(value: Appearance) { localStorage.setItem('aurea.appearance', value); apply(); }
preference.addEventListener('change', () => { if (appearance() === 'system') apply(); });
apply();
