let cancelCurrent: (() => void) | undefined;

// Keep validation errors next to the name, without losing the user's input.
export function editName(host: HTMLElement, initial: string, label: string, submit: (name: string) => Promise<void>, selectStem = false) {
  if (document.querySelector('.inline-name button:disabled')) return;
  cancelCurrent?.();
  const form = document.createElement('form'); form.className = 'inline-name';
  const input = document.createElement('input'); input.className = 'entry-name-input'; input.value = initial; input.required = true; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-label', label);
  const hint = document.createElement('small'); hint.textContent = label;
  const error = document.createElement('small'); error.className = 'inline-name-error'; error.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'inline-name-actions';
  const done = document.createElement('button'); done.type = 'submit'; done.textContent = initial ? 'Rename' : 'Create';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  actions.append(cancel, done); form.append(hint, input, error, actions); host.prepend(form);
  let busy = false;
  const finish = () => { if (busy) return; form.remove(); if (cancelCurrent === finish) cancelCurrent = undefined; };
  cancelCurrent = finish; cancel.onclick = finish;
  form.onkeydown = event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); finish(); host.focus(); } };
  form.onclick = event => event.stopPropagation();
  form.onsubmit = event => {
    event.preventDefault(); if (busy) return; busy = true; done.disabled = true; cancel.disabled = true; input.readOnly = true;
    void submit(input.value).then(() => { busy = false; finish(); }).catch(reason => {
      busy = false; input.readOnly = false; done.disabled = false; cancel.disabled = false;
      error.textContent = String(reason); input.setAttribute('aria-invalid', 'true'); input.focus();
    });
  };
  input.oninput = () => { input.removeAttribute('aria-invalid'); error.textContent = ''; };
  input.focus(); const dot = initial.lastIndexOf('.'); input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
}
