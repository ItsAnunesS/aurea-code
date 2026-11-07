import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './updater.css';
const status = document.querySelector<HTMLElement>('#status')!;
const detail = document.querySelector<HTMLElement>('#detail')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const actions = document.querySelector<HTMLElement>('#actions')!;
const close = document.querySelector<HTMLButtonElement>('#close')!;
let busy = false;
function failed(error: unknown) {
  busy = false; status.textContent = 'Unable to finish startup.';
  detail.textContent = String(error); actions.hidden = false; progress.hidden = true; close.disabled = false;
}
async function launch() {
  actions.hidden = true; status.textContent = 'Opening your projects…';
  try { await invoke('launch_installed'); } catch (error) { failed(error); }
}
async function update() {
  if (busy) return;
  busy = true; actions.hidden = true; close.disabled = true; progress.hidden = false;
  progress.removeAttribute('value'); status.textContent = 'Checking for updates…'; detail.textContent = '';
  try { await invoke('update_before_launch'); busy = false; await launch(); } catch (error) { failed(error); }
}
document.querySelector<HTMLButtonElement>('#retry')!.onclick = () => void update();
document.querySelector<HTMLButtonElement>('#continue')!.onclick = () => { if (!busy) void launch(); };
close.onclick = () => void getCurrentWindow().close().catch(failed);
async function boot() {
  await listen<{ phase: string; downloaded: number; total: number | null }>('update-progress', ({ payload }) => {
    status.textContent = ({ checking: 'Checking for updates…', downloading: 'Downloading the latest version…', verifying: 'Verifying the update signature…', installing: 'Installing the update…' } as Record<string, string>)[payload.phase] ?? 'Preparing…';
    if (payload.phase === 'downloading' && payload.total) { progress.max = payload.total; progress.value = payload.downloaded; }
    else progress.removeAttribute('value');
    detail.textContent = payload.phase === 'downloading' ? `${(payload.downloaded / 1048576).toFixed(1)} MB downloaded` : '';
  });
  await listen<string>('launch-error', ({ payload }) => failed(payload));
  await update();
}
void boot().catch(failed);
