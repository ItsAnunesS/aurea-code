import { invoke } from '@tauri-apps/api/core';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { editorAppearance } from './editor-theme';
import { languageFor } from './languages.mjs';
import { escapeHtml as html } from './utils.mjs';
import { resultCsv, changedRows } from './database-utils.mjs';
import type { Project } from './types';
import type { DbConnection, DbTable, DbColumn, TableData, ResultSet, DatabaseTool, Engine } from './database-types';
import './database.css';

const engineOptions = '<option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option><option value="mariadb">MariaDB</option><option value="sqlite">SQLite</option>';
export class DatabaseView {
  private project?: Project;
  private connections: DbConnection[] = [];
  private connection?: DbConnection;
  private tables: DbTable[] = [];
  private table?: DbTable;
  private columns: DbColumn[] = [];
  private result: ResultSet = { columns: [], rows: [], affected: 0, truncated: false };
  private sets: ResultSet[] = [];
  private changes = new Map<number, Map<string, string | null>>();
  private editable = false;
  private offset = 0;
  private revision = 0;
  private sqlEditor?: EditorView;
  private modal = document.createElement('dialog');
  private structure = false;
  private connected = false;
  private queryVisible = false;
  private sorting?: { index: number; descending: boolean };
  busy = false;
  private sqlDirty = false;
  get dirty() { return this.pendingEdits || this.sqlDirty; }
  private get pendingEdits() { return this.changes.size > 0; }
  constructor(private host: HTMLElement, private notify: (message: string) => void, private tool: (request: DatabaseTool) => Promise<void>) {
    this.modal.id = 'database-modal'; document.body.append(this.modal);
    host.innerHTML = `<aside class="db-sidebar"><div class="db-heading"><strong>CONNECTIONS</strong><button id="db-new" title="New connection" aria-label="New database connection">+</button></div>
      <div class="db-connection-card"><select id="db-connections" aria-label="Database connection"><option value="">Choose a connection</option></select>
      <div class="db-connection-actions"><span id="db-connection-state">Not connected</span><button id="db-connect">Connect</button><details class="db-menu"><summary aria-label="Connection options" title="Connection options">⋯</summary><div><button id="db-edit">Edit connection</button><button id="db-remove">Remove connection</button></div></details></div></div>
      <div class="db-heading db-tables-heading"><strong>TABLES & VIEWS</strong><span id="db-table-count">0</span></div>
      <input id="db-filter-tables" placeholder="Find a table…" aria-label="Filter tables"><div id="db-tree"></div>
      <details class="db-bottom"><summary>Database tools</summary><div><button id="db-docker">Connect Docker container</button><button id="db-create">Create Docker server</button><button id="db-tools">Clients & versions</button></div></details></aside>
      <div class="db-workspace"><header class="db-workspace-header"><div class="db-identity"><span class="db-eyebrow" id="db-subtitle">Explore your project data</span><strong id="db-title">Database workspace</strong></div><span id="db-engine" class="badge">Not connected</span><button id="db-toggle-sql" class="small-button" aria-expanded="false" aria-controls="db-query-panel">SQL editor</button></header>
      <section id="db-query-panel" aria-label="SQL editor" hidden><div class="db-query-toolbar"><strong>Query</strong><span>Ctrl Enter to run selection or script</span><button id="db-save-sql" class="small-button">Save SQL as…</button><button id="db-run" class="primary-button">▶ Run SQL</button><button id="db-cancel" class="small-button" disabled>Cancel</button></div>
      <div id="db-sql"></div><details class="db-query-note"><summary>Each run is a new session · changes may commit immediately</summary><p>Include transactions in one script. Results are limited to 500 rows per statement, with a 30-second timeout.</p></details></section>
      <div class="db-result-toolbar"><div class="db-result-tabs"><button id="db-data" class="active" aria-pressed="true">Data</button><button id="db-structure" aria-pressed="false">Structure</button></div><select id="db-result-set" aria-label="Result set" hidden></select><span id="db-result-label">No results</span><button id="db-refresh" title="Reload current table or schema">↻ Refresh</button><button id="db-export">Export CSV</button></div>
      <div id="db-pending" hidden><span id="db-pending-label" role="status"></span><button id="db-revert">Discard edits</button><button id="db-apply" class="primary-button">Apply changes</button></div>
      <div id="db-results" tabindex="0" aria-label="Database results"></div>
      <footer class="db-footer"><span id="db-status" role="status">Ready</span><div id="db-pagination" hidden><button id="db-previous" disabled>← Previous</button><span id="db-page"></span><button id="db-next" disabled>Next →</button></div></footer></div>`;
    const bind = (selector: string, action: () => Promise<unknown> | unknown) => {
      this.el<HTMLButtonElement>(selector).onclick = () => { if (!this.busy || selector === '#db-cancel') { this.el<HTMLDetailsElement>('.db-menu').open = false; void this.perform(action); } };
    };
    bind('#db-toggle-sql', () => this.showQuery(!this.queryVisible));
    bind('#db-new', () => this.connectionForm());
    bind('#db-edit', () => this.connection && this.connectionForm(this.connection));
    bind('#db-remove', () => this.removeConnection());
    bind('#db-connect', () => this.connect());
    bind('#db-save-sql', () => this.saveSql());
    bind('#db-run', () => this.run());
    bind('#db-cancel', () => invoke('db_cancel', this.args()));
    bind('#db-refresh', async () => { if (await this.discard()) { if (this.table) await this.loadTable(this.table, this.offset); else await this.connect(); } });
    bind('#db-apply', () => this.apply());
    bind('#db-revert', async () => { if (await this.discard()) this.renderResult(); });
    bind('#db-data', () => { this.structure = false; this.renderResult(); });
    bind('#db-structure', () => { this.structure = true; this.renderResult(); });
    bind('#db-export', () => this.exportCsv());
    bind('#db-tools', () => this.toolsForm());
    bind('#db-docker', () => this.dockerForm());
    bind('#db-create', () => this.createServer());
    bind('#db-previous', async () => { if (this.table && await this.discard()) await this.loadTable(this.table, Math.max(0, this.offset - 200)); });
    bind('#db-next', async () => { if (this.table && await this.discard()) await this.loadTable(this.table, this.offset + 200); });
    this.el<HTMLSelectElement>('#db-connections').onchange = () => void this.perform(async () => {
      const selected = this.el<HTMLSelectElement>('#db-connections').value;
      if (this.busy || !await this.discard()) { this.renderConnections(); return; }
      this.connection = this.connections.find(c => c.id === selected); this.connected = false; this.renderConnections(); this.clearResults(); this.tables = []; this.renderTree();
      this.el<HTMLInputElement>('#db-filter-tables').value = '';
      if (this.connection) await this.connect(); else this.status('Choose or add a connection.');
    });
    this.el<HTMLInputElement>('#db-filter-tables').oninput = () => this.renderTree();
    this.el<HTMLSelectElement>('#db-result-set').onchange = () => { this.result = this.sets[Number(this.el<HTMLSelectElement>('#db-result-set').value)]; this.sorting = undefined; this.renderResult(); };
  }
  private showQuery(visible: boolean) {
    this.queryVisible = visible;
    this.el('#db-query-panel').hidden = !visible;
    this.el('#db-toggle-sql').setAttribute('aria-expanded', String(visible));
    this.el('#db-toggle-sql').classList.toggle('active', visible);
    if (visible) { this.sqlEditor?.requestMeasure(); this.sqlEditor?.focus(); }
  }
  private updateControls() {
    for (const id of ['db-connect', 'db-edit', 'db-remove', 'db-run', 'db-refresh']) this.el<HTMLButtonElement>(`#${id}`).disabled = this.busy || !this.connection;
    this.el<HTMLButtonElement>('#db-export').disabled = this.busy || !this.result.columns.length || this.pendingEdits;
    this.el<HTMLSelectElement>('#db-connections').disabled = this.busy;
    this.el('#db-connection-state').textContent = this.connected ? 'Connected' : 'Not connected';
    this.el('#db-connection-state').classList.toggle('connected', this.connected);
    this.el('#db-connect').textContent = this.connected ? 'Reconnect' : 'Connect';
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string) { return this.host.querySelector<T>(selector)!; }
  private args() { if (!this.project || !this.connection) throw new Error('Choose a database connection first.'); return { projectId: this.project.id, connectionId: this.connection.id }; }
  private status(text: string) { this.el('#db-status').textContent = text; }
  private async perform(action: () => Promise<unknown> | unknown) { try { await action(); } catch (error) { this.status(String(error)); this.notify(String(error)); } }
  private async operation<T>(label: string, action: () => Promise<T>, cancellable = false) {
    if (this.busy) throw new Error('Wait for the current database operation.');
    this.busy = true; this.status(label); this.updateControls(); this.el('#db-results').setAttribute('aria-busy', 'true');
    this.el<HTMLButtonElement>('#db-cancel').disabled = !cancellable;
    this.host.classList.add('db-busy');
    try { return await action(); } finally { this.busy = false; this.updateControls(); this.el('#db-results').setAttribute('aria-busy', 'false'); this.host.classList.remove('db-busy'); this.el<HTMLButtonElement>('#db-cancel').disabled = true; }
  }
  async activate(project: Project) {
    if (this.project?.id === project.id) { this.sqlEditor?.requestMeasure(); return; }
    this.connected = false; this.showQuery(false); this.el<HTMLInputElement>('#db-filter-tables').value = '';
    this.project = project; const revision = ++this.revision; this.connection = undefined; this.tables = []; this.clearResults();
    this.sqlEditor?.destroy(); this.sqlDirty = false;
    const language = await languageFor('query.sql')?.load();
    if (revision !== this.revision) return;
    this.sqlEditor = new EditorView({ parent: this.el('#db-sql'), state: EditorState.create({ doc: '-- Write SQL here, or open a table in the explorer.\n', extensions: [basicSetup, editorAppearance(), language ?? [], EditorView.lineWrapping, EditorView.updateListener.of(update => { if (update.docChanged) this.sqlDirty = true; }), keymap.of([{ key: 'Mod-s', run: () => { void this.perform(() => this.saveSql()); return true; } },{ key: 'Mod-Enter', run: () => { if (!this.busy) void this.perform(() => this.run()); return true; } }]), EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'Consolas, monospace', fontSize: '12px' } })] }) });
    await this.refreshConnections(); this.renderTree(); this.renderResult();
  }
  reset() { this.revision++; this.project = undefined; this.connection = undefined; this.changes.clear(); this.sqlEditor?.destroy(); this.sqlEditor = undefined; this.sqlDirty = false; }
  private async refreshConnections() {
    if (!this.project) return;
    const projectId = this.project.id;
    const connections = await invoke<DbConnection[]>('db_connections', { projectId });
    if (this.project?.id !== projectId) return;
    this.connections = connections;
    this.connection = this.connections.find(c => c.id === this.connection?.id) ?? this.connections[0];
    this.renderConnections();
  }
  private renderConnections() {
    this.el<HTMLSelectElement>('#db-connections').innerHTML = '<option value="">Choose a connection</option>' + this.connections.map(c => `<option value="${html(c.id)}">${html(c.name)} · ${html(c.engine)}</option>`).join('');
    this.el<HTMLSelectElement>('#db-connections').value = this.connection?.id ?? '';
    this.el('#db-title').textContent = this.connection?.name ?? 'Database workspace';
    this.el('#db-subtitle').textContent = this.connection ? (this.connection.engine === 'sqlite' ? this.connection.database : `${this.connection.host}:${this.connection.port} / ${this.connection.database}`) : 'Choose a connection';
    this.el('#db-engine').textContent = this.connection?.engine ?? 'Not connected';
    this.updateControls();
  }
  private clearResults() {
    this.table = undefined; this.columns = []; this.changes.clear(); this.editable = false; this.sorting = undefined; this.sets = []; this.offset = 0;
    this.result = { columns: [], rows: [], affected: 0, truncated: false };
    this.el('#db-result-set').hidden = true; this.renderResult();
  }
  private async form(title: string, fields: string, submit = 'Continue', setup?: (form: HTMLFormElement) => void): Promise<FormData | null> {
    if (this.modal.open) return null;
    this.modal.innerHTML = `<form method="dialog"><h2>${html(title)}</h2>${fields}<div class="modal-actions"><button type="button" id="db-dialog-cancel" class="small-button">Cancel</button><button type="submit" class="primary-button">${html(submit)}</button></div></form>`;
    const form = this.modal.querySelector('form')!;
    return new Promise(resolve => {
      let result: FormData | null = null;
      form.onsubmit = event => { event.preventDefault(); if (!form.reportValidity()) return; result = new FormData(form); this.modal.close(); };
      this.modal.querySelector<HTMLButtonElement>('#db-dialog-cancel')!.onclick = () => this.modal.close();
      this.modal.onclose = () => { this.modal.onclose = null; form.reset(); this.modal.replaceChildren(); resolve(result); };
      setup?.(form); this.modal.showModal(); form.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    });
  }
  private async discard() {
    if (!this.pendingEdits) return true;
    if (!await this.form('Discard pending edits?', '<p>Changes in the data grid have not been applied.</p>', 'Discard')) return false;
    this.changes.clear(); this.renderResult(); return true;
  }
  private async connectionForm(existing?: DbConnection, preset?: Partial<DbConnection>) {
    if (!this.project || !await this.discard()) return;
    const value = { name: '', engine: 'postgres', host: '127.0.0.1', port: 5432, username: 'postgres', database: '', tls: true, ...existing, ...preset };
    const data = await this.form(existing ? 'Edit connection' : 'New connection', `
      <label>Name<input name="name" required maxlength="80" value="${html(value.name)}" placeholder="e.g. Local development"></label>
      <label>Engine<select name="engine">${engineOptions}</select></label>
      <div class="db-network"><div class="db-form-row"><label>Host<input name="host" value="${html(value.host)}"></label><label>Port<input name="port" type="number" min="1" max="65535" value="${value.port}"></label></div>
      <label>Username<input name="username" autocomplete="off" value="${html(value.username)}"></label>
      <label>Password<input type="password" name="password" autocomplete="new-password" placeholder="${existing ? 'Leave blank to keep the current password' : 'Connection password'}"></label>
      <label class="db-checkbox"><input type="checkbox" name="remember" ${existing?.saved_password ? 'checked' : ''}>Remember password in system vault</label>
      <label class="db-checkbox"><input type="checkbox" name="tls" ${value.tls ? 'checked' : ''}>Verify TLS certificate and hostname</label></div>
      <label><span id="db-database-label">Database</span><input name="database" required value="${html(value.database)}"></label>
      <p class="muted">SQLite uses an existing file relative to the project, including an empty file created in the explorer. Passwords are never saved in project files.</p>`, 'Save connection', form => {
      const engine = form.elements.namedItem('engine') as HTMLSelectElement; engine.value = value.engine;
      const update = () => { const sqlite = engine.value === 'sqlite'; form.querySelector<HTMLElement>('.db-network')!.hidden = sqlite; form.querySelector('#db-database-label')!.textContent = sqlite ? 'SQLite path relative to project' : 'Database'; };
      engine.onchange = () => { (form.elements.namedItem('port') as HTMLInputElement).value = engine.value === 'postgres' ? '5432' : '3306'; (form.elements.namedItem('username') as HTMLInputElement).value = engine.value === 'postgres' ? 'postgres' : 'root'; update(); }; update();
    });
    if (!data) return;
    this.connection = await this.operation('Saving connection…', () => invoke<DbConnection>('db_save_connection', {
      connection: { id: existing?.id ?? '', project_id: this.project!.id, name: data.get('name'), engine: data.get('engine'), host: data.get('host'), port: Number(data.get('port')), username: data.get('username'), database: data.get('database'), tls: data.has('tls'), saved_password: false },
      password: existing && !data.get('password') ? null : String(data.get('password') ?? ''), remember: data.has('remember'),
    }));
    await this.refreshConnections(); this.clearResults(); await this.connect();
  }
  private async removeConnection() {
    if (!this.connection || !await this.discard()) return;
    if (!await this.form('Remove connection?', `<p>Remove ${html(this.connection.name)} and its saved credential? The database and containers are kept.</p>`, 'Remove')) return;
    await this.operation('Removing connection…', () => invoke('db_remove_connection', this.args()));
    this.connection = undefined; this.connected = false; this.tables = []; this.clearResults(); await this.refreshConnections(); this.renderTree(); this.renderResult(); this.status('Connection removed.');
  }
  private async connect() {
    if (!await this.discard()) return;
    this.connected = false; this.tables = []; this.clearResults(); this.renderTree(); this.updateControls();
    this.tables = await this.operation('Connecting and discovering schema…', () => invoke<DbTable[]>('db_tables', this.args()));
    this.connected = true; this.clearResults(); this.renderTree(); this.updateControls();
    this.el('#db-title').textContent = this.connection!.name;
    this.el('#db-subtitle').textContent = this.connection!.engine === 'sqlite' ? this.connection!.database : `${this.connection!.host}:${this.connection!.port} / ${this.connection!.database}`;
    this.el('#db-engine').textContent = this.connection!.engine;
    this.status(`Connected · ${this.tables.length} tables and views`);
  }
  private renderTree() {
    const host = this.el('#db-tree'); host.replaceChildren();
    this.el('#db-table-count').textContent = String(this.tables.length);
    const query = this.el<HTMLInputElement>('#db-filter-tables').value.toLowerCase();
    const groups = new Map<string, DbTable[]>();
    for (const table of this.tables.filter(t => `${t.schema}.${t.name}`.toLowerCase().includes(query))) groups.set(table.schema, [...(groups.get(table.schema) ?? []), table]);
    for (const [schema, tables] of groups) {
      const group = document.createElement('details'); group.open = true;
      const summary = document.createElement('summary'); summary.textContent = `${schema} · ${tables.length}`; group.append(summary);
      for (const table of tables) {
        const button = document.createElement('button'); button.className = 'db-table'; button.textContent = `${table.kind === 'view' ? '◇' : '▦'}  ${table.name}`; button.title = `${schema}.${table.name}`;
        const selected = this.table?.schema === schema && this.table?.name === table.name; button.classList.toggle('active', selected);
        button.onclick = () => { if (!this.busy) void this.perform(async () => { if (await this.discard()) await this.loadTable(table, 0); }); }; group.append(button);

      }
      host.append(group);
    }
    if (!groups.size) { const empty = document.createElement('p'); empty.textContent = query && this.tables.length ? 'No tables match your search.' : this.connected ? 'No tables or views in this database.' : this.connection ? 'Connect to browse tables and views.' : 'Your saved connections will appear here.'; host.append(empty); }
  }
  private async loadTable(table: DbTable, offset: number) {
    const data = await this.operation('Loading table…', () => invoke<TableData>('db_table', { ...this.args(), table, offset }));
    this.table = table; this.offset = offset; this.columns = data.columns; this.result = data.data; this.result.columns = data.columns.map(c => c.name);
    this.editable = data.editable; this.structure = false; this.sorting = undefined; this.changes.clear(); this.el('#db-result-set').hidden = true;
    this.showQuery(false); this.renderTree(); this.renderResult(); this.status(data.editable ? 'Double-click a cell to stage an edit. Apply changes to commit.' : 'Read-only grid: views and tables without a supported primary key can be queried in SQL.');
  }
  private async run() {
    if (!this.sqlEditor || !await this.discard()) return;
    this.showQuery(true);
    const selection = this.sqlEditor.state.selection.main;
    const sql = selection.empty ? this.sqlEditor.state.doc.toString() : this.sqlEditor.state.sliceDoc(selection.from, selection.to);
    const start = performance.now();
    this.sets = await this.operation('Executing SQL…', () => invoke<ResultSet[]>('db_query', { ...this.args(), sql }), true);
    this.table = undefined; this.columns = []; this.editable = false; this.structure = false; this.sorting = undefined;
    this.result = this.sets[0] ?? { columns: [], rows: [], affected: 0, truncated: false };
    this.el<HTMLSelectElement>('#db-result-set').innerHTML = this.sets.map((_, i) => `<option value="${i}">Result ${i + 1}</option>`).join('');
    this.el('#db-result-set').hidden = this.sets.length < 2;
    this.renderTree(); this.renderResult(); this.status(`Completed in ${Math.round(performance.now() - start)} ms · ${this.sets.length} statement results`);
  }
  private renderResult() {
    const host = this.el('#db-results'); host.replaceChildren();
    this.updateControls();
    this.el('#db-pending').hidden = !this.pendingEdits;
    this.el('#db-pending-label').textContent = `${this.changes.size} row${this.changes.size === 1 ? '' : 's'} with unsaved edits`;
    this.el('#db-pagination').hidden = !this.table;
    this.el('#db-title').textContent = this.table?.name ?? (this.sets.length ? 'Query results' : this.connection?.name ?? 'Database workspace');
    this.el('#db-subtitle').textContent = this.table ? `${this.connection?.name} / ${this.table.schema}` : this.connection ? `${this.connection.name} / ${this.connection.database}` : 'Explore your project data';
    this.el('#db-data').setAttribute('aria-pressed', String(!this.structure));
    this.el('#db-structure').setAttribute('aria-pressed', String(this.structure));
    this.el('#db-data').classList.toggle('active', !this.structure); this.el('#db-structure').classList.toggle('active', this.structure);
    this.el<HTMLButtonElement>('#db-apply').disabled = !this.pendingEdits;
    this.el<HTMLButtonElement>('#db-revert').disabled = !this.pendingEdits;
    this.el<HTMLButtonElement>('#db-structure').disabled = !this.columns.length;
    this.el<HTMLButtonElement>('#db-previous').disabled = !this.table || this.offset === 0;
    this.el<HTMLButtonElement>('#db-next').disabled = !this.table || this.result.rows.length < 200;
    this.el('#db-page').textContent = this.table ? (this.result.rows.length ? `${this.offset + 1}–${this.offset + this.result.rows.length}` : 'No rows on this page') : '';
    this.el('#db-result-label').textContent = this.table ? `${this.result.rows.length} rows on this page${this.editable ? '' : ' · Read only'}` : this.sets.length ? `${this.result.rows.length} rows · ${this.result.affected} affected${this.result.truncated ? ' · Limit reached' : ''}` : 'Table browser';
    const table = document.createElement('table'); table.className = 'db-grid';
    const head = table.createTHead().insertRow();
    const names = this.structure ? ['Column', 'Type', 'Primary key', 'Nullable', 'Editable'] : this.result.columns;
    head.insertCell().textContent = '#';
    names.forEach((name, index) => {
      const th = document.createElement('th'); th.scope = 'col';
      const button = document.createElement('button'); button.textContent = `${!this.structure && this.columns[index]?.primary_key ? '⚿ ' : ''}${name}${this.sorting?.index === index ? (this.sorting.descending ? ' ↓' : ' ↑') : ''}`;
      button.title = 'Sort this loaded page';
      button.onclick = () => { if (this.structure) return; this.sorting = { index, descending: this.sorting?.index === index && !this.sorting.descending }; this.renderResult(); };
      th.append(button); head.append(th);
    });
    const body = table.createTBody();
    if (this.structure) {
      this.columns.forEach((column, index) => { const row = body.insertRow(); [String(index + 1), column.name, column.data_type, column.primary_key ? 'Yes' : 'No', column.nullable ? 'Yes' : 'No', this.editable && column.editable && !column.primary_key ? 'Yes' : 'No'].forEach(value => row.insertCell().textContent = value); });
    } else {
      const rows = this.result.rows.map((values, index) => ({ values, index }));
      if (this.sorting) { const sort = this.sorting; rows.sort((a, b) => String(a.values[sort.index] ?? '').localeCompare(String(b.values[sort.index] ?? ''), undefined, { numeric: true }) * (sort.descending ? -1 : 1)); }
      for (const { values, index } of rows) {
        const row = body.insertRow(); row.insertCell().textContent = String(this.offset + index + 1);
        values.forEach((original, columnIndex) => {
          const name = this.result.columns[columnIndex]; const pending = this.changes.get(index);
          const value = pending?.has(name) ? pending.get(name)! : original;
          const cell = row.insertCell(); cell.textContent = value === null ? 'NULL' : value;
          cell.classList.toggle('null', value === null); cell.classList.toggle('pending', pending?.has(name) ?? false); cell.title = value ?? 'NULL';
          if (this.editable && this.columns[columnIndex]?.editable && !this.columns[columnIndex]?.primary_key) {
            cell.tabIndex = 0; cell.classList.add('editable'); cell.setAttribute('aria-label', `Edit ${name}, row ${index + 1}`);
            cell.ondblclick = () => { if (!this.busy) void this.perform(() => this.editCell(index, columnIndex)); };
            cell.onkeydown = event => { if (event.key === 'Enter' && !this.busy) { event.preventDefault(); void this.perform(() => this.editCell(index, columnIndex)); } };
          }
        });
      }
    }
    if (names.length) host.append(table);
    else {
      const empty = document.createElement('div'); empty.className = 'db-empty';
      const icon = document.createElement('span'); icon.className = 'db-empty-icon'; icon.textContent = '▦'; icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h2'); const description = document.createElement('p');
      title.textContent = this.sets.length ? 'Query completed' : this.connected ? 'Choose a table to explore' : this.connection ? 'Open your database' : 'Your data starts here';
      description.textContent = this.sets.length ? 'This statement returned no columns. See the affected row count above.' : this.connected ? 'Browse rows, inspect columns and edit values. Open the SQL editor whenever you need a query.' : this.connection ? 'Connect to browse tables and views, or open the SQL editor to run a query.' : 'Connect PostgreSQL, MySQL, MariaDB or a local SQLite file to explore your project data.';
      empty.append(icon, title, description);
      const button = document.createElement('button'); button.className = 'primary-button';
      button.textContent = this.connected || this.sets.length ? 'Open SQL editor' : this.connection ? 'Connect to database' : 'Add connection';
      button.onclick = () => { if (!this.busy) void this.perform(() => this.connected || this.sets.length ? this.showQuery(true) : this.connection ? this.connect() : this.connectionForm()); };
      empty.append(button); host.append(empty);
    }
  }
  private async editCell(row: number, column: number) {
    const meta = this.columns[column]; const original = this.result.rows[row][column];
    const value = this.changes.get(row)?.has(meta.name) ? this.changes.get(row)!.get(meta.name)! : original;
    const data = await this.form(`Edit ${meta.name}`, `<p class="muted">${html(meta.data_type)} · changes are staged until applied</p><label>Value<textarea name="value" rows="5" maxlength="1048576">${html(value ?? '')}</textarea></label><label class="db-checkbox"><input type="checkbox" name="null" ${value === null ? 'checked' : ''} ${!meta.nullable ? 'disabled' : ''}>SQL NULL (different from an empty string)</label>`, 'Stage change');
    if (!data) return;
    const next = data.has('null') ? null : String(data.get('value'));
    const changes = this.changes.get(row) ?? new Map();
    if (next === original) changes.delete(meta.name); else changes.set(meta.name, next);
    if (changes.size) this.changes.set(row, changes); else this.changes.delete(row);
    this.renderResult();
  }
  private async apply() {
    if (!this.table || !this.pendingEdits) return;
    if (!await this.form('Apply database changes?', `<p>Commit edits to ${this.changes.size} rows in <strong>${html(this.connection!.name)} / ${html(this.table.name)}</strong>?</p><p>All edits are applied in one transaction. A conflicting row cancels the batch.</p>`, 'Apply changes')) return;
    const count = await this.operation('Applying changes…', () => invoke<number>('db_apply', { ...this.args(), table: this.table, changes: changedRows(this.result.rows, this.changes) }));
    this.changes.clear(); await this.loadTable(this.table, this.offset); this.status(`${count} rows updated.`);
  }
  async saveSql() {
    if (!this.project || !this.sqlEditor || this.busy) return;
    const data = await this.form('Save SQL as a new project file', '<label>Path relative to project<input name="path" value="query.sql" required></label><p>Existing files are not overwritten. Use the regular editor to continue editing a saved script.</p>', 'Save SQL');
    if (!data) return;
    const relative = String(data.get('path'));
    const content = this.sqlEditor.state.doc.toString();
    await invoke('create_file', { projectId: this.project.id, relative });
    await invoke('save_file', { projectId: this.project.id, relative, content, original: '' });
    this.sqlDirty = false; this.status(`Saved ${relative}`);
  }
  private async exportCsv() {
    if (!this.project || !this.result.columns.length) return;
    if (this.pendingEdits) throw new Error('Apply or revert pending edits before exporting.');
    const data = await this.form('Export loaded results', '<label>New file relative to project<input name="path" value="query-results.csv" required></label><p>Exports the loaded page. Existing files are not overwritten; spreadsheet formulas are escaped.</p>', 'Export');
    if (!data) return;
    const relative = String(data.get('path'));
    await invoke('create_file', { projectId: this.project.id, relative });
    await invoke('save_file', { projectId: this.project.id, relative, content: resultCsv(this.result.columns, this.result.rows), original: '' }); this.status(`Exported ${relative}`);
  }
  private async toolsForm() {
    const data = await this.form('Database clients & versions', `<label>Engine<select name="engine">${engineOptions}</select></label><label>Source<select name="source"><option value="docker">Official Docker image</option><option value="native">Native system package</option></select></label><label id="db-client-tag">Docker tag<input name="version" value="17-alpine" required></label><label id="db-native-action" hidden>Native action<select name="native_action"><option value="install">Install a package version</option><option value="console">Open installed client console</option></select></label><p>Docker clients are isolated. Native packages are installed by APT (Linux) or winget (Windows), may include vendor server tools, and may request administrator access.</p>`, 'Choose action', form => {
      const engine = form.elements.namedItem('engine') as HTMLSelectElement; engine.value = this.connection?.engine ?? 'postgres';
      const version = form.elements.namedItem('version') as HTMLInputElement;
      const source = form.elements.namedItem('source') as HTMLSelectElement;
      const update = () => { version.value = engine.value === 'postgres' ? '17-alpine' : engine.value === 'mysql' ? '8.4' : '11.4'; if (engine.value === 'sqlite') source.value = 'native'; form.querySelector<HTMLElement>('#db-client-tag')!.hidden = source.value === 'native'; form.querySelector<HTMLElement>('#db-native-action')!.hidden = source.value !== 'native'; };
      engine.onchange = update; source.onchange = update; update();
    });
    if (!data) return;
    const engine = String(data.get('engine')) as Engine;
    if (data.get('source') === 'native') {
      if (data.get('native_action') === 'console') { await this.tool({ action: 'native-console', engine, version: '', connection_id: this.connection?.id ?? null }); return; }
      const versions = await this.operation('Reading system package versions…', () => invoke<{ value: string; label: string }[]>('db_native_versions', { engine }));
      if (!versions.length) throw new Error('No package versions found. Refresh your system package catalog or install the client manually.');
      const choice = await this.form('Native client', `<label>Available package version<select name="version">${versions.map(v => `<option value="${html(v.value)}">${html(v.label)}</option>`).join('')}</select></label><label>Action<select name="action"><option value="install-native">Install selected version</option><option value="native-console">Open installed client console</option></select></label><p>The installation command runs visibly in the terminal. Your system controls elevation and package verification.</p>`, 'Open terminal');
      if (choice) await this.tool({ action: String(choice.get('action')) as DatabaseTool['action'], engine, version: String(choice.get('version') ?? ''), connection_id: this.connection?.id ?? null });
    } else {
      const choice = await this.form('Docker client', `<p>Official image: ${html(engine)}:${html(data.get('version'))}</p><label>Action<select name="action"><option value="pull">Download image only</option><option value="docker-console">Open isolated client console</option></select></label><p>A console requires a matching saved connection. Loopback hosts use host networking on Linux or the Docker host gateway on Windows; the database must be reachable from containers.</p>`, 'Open terminal');
      if (choice) await this.tool({ action: String(choice.get('action')) as DatabaseTool['action'], engine, version: String(data.get('version')), connection_id: this.connection?.id ?? null });
    }
  }
  private async dockerForm() {
    if (!this.project) return;
    const containers = await this.operation('Finding project containers…', () => invoke<{ id: string; name: string; image: string; ports: Record<string, { HostIp: string; HostPort: string }[] | null> }[]>('db_docker_containers', { projectId: this.project!.id }));
    const options: { name: string; image: string; port: number }[] = [];
    for (const container of containers) for (const [port, bindings] of Object.entries(container.ports ?? {})) {
      if (['5432/tcp', '3306/tcp'].includes(port)) for (const binding of bindings ?? []) options.push({ name: container.name.replace(/^\//, ''), image: container.image, port: Number(binding.HostPort) });
    }
    if (!options.length) { this.status('No project database containers with published ports found. Use a direct connection for other Docker contexts or networks.'); return; }
    const data = await this.form('Connect Docker database', `<label>Container<select name="index">${options.map((c, i) => `<option value="${i}">${html(c.name)} · ${html(c.image)} · port ${c.port}</option>`).join('')}</select></label><p>Credentials are entered explicitly. Container environment secrets are never read. For a remote Docker context, change the connection host.</p>`);
    if (!data) return;
    const item = options[Number(data.get('index'))];
    await this.connectionForm(undefined, { name: item.name, engine: item.image.includes('postgres') ? 'postgres' : item.image.includes('mariadb') ? 'mariadb' : 'mysql', port: item.port, tls: false });
  }
  private async createServer() {
    if (!this.project) return;
    const data = await this.form('Create Docker database', `<label>Engine<select name="engine">${engineOptions.replace('<option value="sqlite">SQLite</option>', '')}</select></label><div class="db-form-row"><label>Image tag<input name="version" value="17-alpine" required></label><label>Local port<input type="number" name="port" value="5432" min="1" max="65535" required></label></div><label>Database<input name="database" value="app" pattern="[A-Za-z0-9_]+" required></label><label>Username<input name="username" value="app" pattern="[A-Za-z0-9_]+" required></label><label>Password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><p>Downloads the official image if needed and creates a new server with a persistent named volume. Port binding is restricted to 127.0.0.1. Existing containers and volumes are never replaced.</p>`, 'Create server', form => {
      (form.elements.namedItem('engine') as HTMLSelectElement).onchange = () => {
        const engine = (form.elements.namedItem('engine') as HTMLSelectElement).value;
        (form.elements.namedItem('version') as HTMLInputElement).value = engine === 'postgres' ? '17-alpine' : engine === 'mysql' ? '8.4' : '11.4';
        (form.elements.namedItem('port') as HTMLInputElement).value = engine === 'postgres' ? '5432' : '3306';
      };
    });
    if (!data) return;
    const message = await this.operation('Downloading image and creating server (up to 5 minutes)…', () => invoke<string>('db_create_server', { projectId: this.project!.id, request: { engine: data.get('engine'), version: data.get('version'), port: Number(data.get('port')), database: data.get('database'), username: data.get('username'), password: data.get('password') } }));
    this.status(message); this.notify(message);
    this.connection = await invoke<DbConnection>('db_save_connection', { connection: { id: '', project_id: this.project.id, name: String(data.get('database')), engine: data.get('engine'), host: '127.0.0.1', port: Number(data.get('port')), database: data.get('database'), username: data.get('username'), tls: false, saved_password: false }, password: data.get('password'), remember: false });
    this.connected = false; await this.refreshConnections(); this.clearResults(); this.tables = []; this.renderTree(); this.status(message + ' Connection saved for this session; click Connect when ready.');
  }
}
