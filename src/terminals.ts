import { Channel, invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Project } from './types';
import '@xterm/xterm/css/xterm.css';

type TerminalEvent = { type: 'output'; data: number[] } | { type: 'exit'; code: string } | { type: 'error'; message: string };
interface Session { id?: string; label: string; terminal: Terminal; fit: FitAddon; host: HTMLDivElement; tab: HTMLButtonElement; exited: boolean; observer: ResizeObserver; channel: Channel<TerminalEvent> }
export class TerminalManager {
  sessions: Session[] = [];
  private selected?: Session;
  private opening = false;
  private closing = false;
  private projectId?: string;
  activate(projectId: string) {
    if (this.projectId !== projectId && this.sessions.length) throw new Error('Close terminals before switching projects.');
    this.projectId = projectId;
  }
  constructor(private panel: HTMLElement, private tabs: HTMLElement, private host: HTMLElement, private report: (message: string) => void) {}
  get running() { return this.sessions.filter(s => !s.exited).length; }
  hide() { this.panel.hidden = true; }
  show() { this.panel.hidden = false; if (this.selected) this.select(this.selected); }
  private select(session: Session) {
    this.selected = session; this.panel.hidden = false;
    for (const item of this.sessions) { item.host.hidden = item !== session; item.tab.classList.toggle('active', item === session); }
    requestAnimationFrame(() => { session.fit.fit(); session.terminal.focus(); });
  }
  async start(project: Project, kind: 'shell' | 'compose') {
    if (this.closing || project.id !== this.projectId) throw new Error('The project is no longer active.');
    if (this.opening) return;
    if (this.sessions.length >= 8) throw new Error('Close a terminal before opening another (maximum: 8).');
    this.opening = true;
    this.panel.hidden = false;
    const host = document.createElement('div'); host.className = 'terminal-host'; this.host.append(host);
    const terminal = new Terminal({ cursorBlink: true, fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 12, scrollback: 3000, theme: { background: '#131618', foreground: '#d5d8d8', cursor: '#dfc18c', selectionBackground: '#66553e' }, allowProposedApi: false });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
    const tab = document.createElement('button'); tab.className = 'terminal-tab';
    const label = `${project.name} · ${kind === 'compose' ? 'Compose' : 'Terminal'}`;
    tab.textContent = label; this.tabs.append(tab);
    const channel = new Channel<TerminalEvent>();
    const observer = new ResizeObserver(() => { if (!host.hidden && !this.panel.hidden) fit.fit(); }); observer.observe(host);
    const session: Session = { label, terminal, fit, host, tab, exited: false, observer, channel };
    this.sessions.push(session); tab.onclick = () => this.select(session); this.select(session);
    channel.onmessage = event => {
      if (event.type === 'output') terminal.write(new Uint8Array(event.data));
      else if (event.type === 'exit') { session.exited = true; terminal.writeln(`\r\n[Process exited: ${event.code}]`); tab.textContent = `${label} · closed`; }
      else this.report(event.message);
    };
    terminal.onData(data => { if (session.id && !session.exited) void invoke('terminal_write', { sessionId: session.id, data }).catch(e => this.report(String(e))); });
    terminal.onResize(({ rows, cols }) => { if (session.id && !session.exited) void invoke('terminal_resize', { sessionId: session.id, rows, cols }).catch(e => this.report(String(e))); });
    try { fit.fit(); session.id = await invoke<string>('terminal_start', { request: { projectId: project.id, kind, rows: Math.max(2, terminal.rows), cols: Math.max(2, terminal.cols) }, onEvent: channel }); }
    catch (error) { this.dispose(session); throw error; }
    finally { this.opening = false; }
  }
  async closeAll() {
    if (this.opening) throw new Error('Wait for the terminal to start before closing the project.');
    this.closing = true;
    try {
      for (const session of [...this.sessions]) {
        if (session.id && !session.exited) await invoke('terminal_stop', { sessionId: session.id });
        this.dispose(session);
      }
      this.projectId = undefined;
    } finally { this.closing = false; }
  }
  async closeSelected() {
    const session = this.selected; if (!session) return;
    if (!session.id && !session.exited) throw new Error('Wait for the terminal to start before closing it.');
    if (session.id && !session.exited) await invoke('terminal_stop', { sessionId: session.id });
    this.dispose(session);
  }
  private dispose(session: Session) {
    session.observer.disconnect(); session.terminal.dispose(); session.host.remove(); session.tab.remove();
    this.sessions = this.sessions.filter(s => s !== session);
    this.selected = this.sessions.at(-1); if (this.selected) this.select(this.selected); else this.hide();
  }
}
