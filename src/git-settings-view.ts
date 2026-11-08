import { invoke } from '@tauri-apps/api/core';
interface Setting { key: string; globalValue: string | null; projectValue: string | null; effectiveValue: string | null; source: string }
const definitions: Record<string, { label: string; options?: string[]; hint: string }> = {
  'user.name': { label: 'Author name', hint: 'Name recorded in new commits.' },
  'user.email': { label: 'Author email', hint: 'Email recorded in new commits.' },
  'init.defaultBranch': { label: 'Initial branch', hint: 'Default for newly initialized repositories.' },
  'core.autocrlf': { label: 'Line ending conversion', options: ['false', 'true', 'input'], hint: 'Git conversion policy when checking files in and out.' },
  'fetch.prune': { label: 'Prune remote branches', options: ['false', 'true'], hint: 'Remove obsolete remote-tracking references on fetch.' },
  'pull.ff': { label: 'Git pull preference', options: ['only', 'true', 'false'], hint: 'Aurea always uses fast-forward-only pull to avoid implicit merges or rebases.' },
};
export class GitSettingsView {
  private revision = 0;
  constructor(private host: HTMLElement, private project: string | null, private report: (text: string) => void) {}
  async render(scope: 'global' | 'project' = this.project ? 'project' : 'global') {
    const revision = ++this.revision;
    this.host.textContent = 'Reading Git settings…';
    try {
      const settings = await invoke<Setting[]>('git_settings_read', { projectId: this.project });
      if (revision !== this.revision || !this.host.isConnected) return;
      this.host.replaceChildren(); this.host.classList.add('git-settings');
      const title = document.createElement('h2'); title.textContent = scope === 'global' ? 'Git on this computer' : 'Project Git settings'; this.host.append(title);
      const note = document.createElement('p'); note.className = 'git-note'; note.textContent = scope === 'global' ? 'Uses your existing global Git configuration. Changes affect all repositories for this computer user. Project overrides may still take precedence in the effective values shown below.' : 'Saved in this repository’s Git configuration. Empty fields inherit the computer settings.'; this.host.append(note);
      if (this.project) {
        const nav = document.createElement('div'); nav.className = 'git-segments';
        for (const value of ['project', 'global'] as const) { const button = document.createElement('button'); button.textContent = value === 'project' ? 'This project' : 'This computer'; button.setAttribute('aria-pressed', String(scope === value)); button.onclick = () => void this.render(value); nav.append(button); } this.host.append(nav);
      }
      for (const setting of settings) {
        const definition = definitions[setting.key]; const form = document.createElement('form'); form.className = 'git-setting';
        const label = document.createElement('label'); label.textContent = definition.label;
        const input = definition.options ? document.createElement('select') : document.createElement('input');
        input.setAttribute('aria-label', `${definition.label} (${scope})`); input.dataset.gitSetting = setting.key;
        if (input instanceof HTMLSelectElement) for (const value of ['', ...definition.options!]) { const option = document.createElement('option'); option.value = value; option.textContent = value || 'Inherit / Git default'; input.append(option); }
        if (input instanceof HTMLInputElement) { input.maxLength = 512; input.placeholder = setting.effectiveValue ?? 'Not configured'; }
        input.value = (scope === 'global' ? setting.globalValue : setting.projectValue) ?? '';
        label.append(input); const hint = document.createElement('small'); hint.textContent = `${definition.hint} Effective: ${setting.effectiveValue ?? 'Git default'} · ${setting.source}`;
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'small-button'; save.textContent = 'Save';
        const result = document.createElement('span'); result.setAttribute('role', 'status');
        form.append(label, save, hint, result);
        form.onsubmit = event => { event.preventDefault(); save.disabled = true; input.disabled = true;
          void invoke('git_setting_write', { projectId: this.project, scope, key: setting.key, value: input.value }).then(() => { this.report('Git setting saved.'); return this.render(scope); }).catch(error => { result.textContent = String(error); save.disabled = false; input.disabled = false; });
        }; this.host.append(form);
      }
    } catch (error) { if (revision === this.revision) this.host.textContent = `Unable to read Git settings: ${String(error)}`; }
  }
}
