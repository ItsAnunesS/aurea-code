"""End-to-end smoke test against a real Tauri WebKit window (tauri-driver on port 4444).

Run only in an isolated container: the test creates a temporary project and workspace.
"""
import base64
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import tempfile
import time
import http.client

CONNECTION = http.client.HTTPConnection('127.0.0.1', 4444, timeout=40)
SESSION = ''

def request(method, path, body=None):
    # Keep the WebDriver transport alive: urllib's Connection: close header is
    # forwarded by tauri-driver and races with its upstream connection pool.
    data = None if body is None else json.dumps(body).encode()
    CONNECTION.request(method, path, body=data, headers={'Content-Type': 'application/json'})
    response = CONNECTION.getresponse()
    payload = response.read().decode()
    assert response.status < 400, payload
    value = json.loads(payload)['value']
    if isinstance(value, dict) and 'error' in value:
        raise AssertionError(value)
    return value

def execute(script, *args):
    return request('POST', f'/session/{SESSION}/execute/sync', {'script': script, 'args': list(args)})

def wait_for(script, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if execute('return ' + script):
            return
        time.sleep(.15)
    print('Timeout diagnostics:', execute('return {toast:document.querySelector("#toast")?.textContent, media:document.querySelector("#media-preview")?.textContent, title:document.querySelector("#editor-title")?.textContent}'))
    raise AssertionError('Timed out: ' + script)

def click(selector):
    value = request('POST', f'/session/{SESSION}/element', {'using': 'css selector', 'value': selector})
    element = value['element-6066-11e4-a52e-4f735466cecf']
    request('POST', f'/session/{SESSION}/element/{element}/click', {})

def double_click(selector):
    value = request('POST', f'/session/{SESSION}/element', {'using': 'css selector', 'value': selector})
    request('POST', f'/session/{SESSION}/actions', {'actions': [{'type': 'pointer', 'id': 'mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': [
        {'type': 'pointerMove', 'duration': 0, 'origin': value, 'x': 0, 'y': 0},
        {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0},
        {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0},
    ]}]})

def enter_launcher():
    wait_for('document.querySelector("#app").dataset.stage === "launcher"')

def input_text(selector, text):
    value = request('POST', f'/session/{SESSION}/element', {'using': 'css selector', 'value': selector})
    element = value['element-6066-11e4-a52e-4f735466cecf']
    request('POST', f'/session/{SESSION}/element/{element}/value', {'text': text})

def invoke(command, args=None):
    value = request('POST', f'/session/{SESSION}/execute/async', {
        'script': 'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ok:true,value})).catch(error => done({ok:false,error}));',
        'args': [command, args or {}],
    })
    assert value['ok'], value
    return value.get('value')

for attempt in range(50):
    try:
        request('GET', '/status')
        break
    except ConnectionRefusedError:
        CONNECTION.close()
        time.sleep(.1)
else:
    raise AssertionError('tauri-driver did not start')

with tempfile.TemporaryDirectory(prefix='aurea-smoke-') as directory:
    project = Path(directory)
    for name in ['preview.png', 'preview.webp', 'preview.pdf']:
        (project / name).write_bytes((Path('/app/tests/fixtures') / name).read_bytes())
    (project / 'preview.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><script>window.svgExecuted=true</script><rect width="40" height="30" fill="blue"/></svg>')
    (project / 'multi-a.txt').write_text('alpha')
    (project / 'multi-b.txt').write_text('beta')
    (project / 'clipboard-target').mkdir()
    (project / 'transfer-target').mkdir()
    (project / 'transfer.txt').write_text('saved transfer content')
    (project / 'main.rs').write_text('fn main() { println!("Hello Aurea"); }\n')
    (project / 'README.md').write_text('# Project guide\n\n**Hello documentation**\n\n| Tool | State |\n| --- | --- |\n| IDE | Ready |\n')
    env_content = 'TOKEN=first-test-secret\nPASSWORD="second-test-secret"\nMULTI="line-one\nline-two"\n'
    (project / '.env').write_text(env_content)
    (project / 'example.py').write_text('def greet(name):\n    return "Hello " + name # greeting\n')
    with sqlite3.connect(project / 'fixture.db') as database:
        database.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)')
        database.execute("INSERT INTO people VALUES (1, 'Alice', NULL)")
    subprocess.run(['git', 'init', '-q', directory], check=True)
    subprocess.run(['git', '-C', directory, 'config', 'user.name', 'Aurea Test'], check=True)
    subprocess.run(['git', '-C', directory, 'config', 'user.email', 'test@example.invalid'], check=True)
    result = request('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': '/app/src-tauri/target/release/aurea-ide'}}}})
    SESSION = result['sessionId']
    try:
        wait_for('document.querySelector("#workspace-select option") !== null')
        enter_launcher()
        assert execute('return document.querySelector(".window-bar").getBoundingClientRect().top') == 0
        assert execute('return document.querySelector("#app").getBoundingClientRect().top') == 38
        assert execute('return [...document.querySelectorAll("[data-menu]")].map(button => button.textContent)') == ['File', 'Edit', 'View']
        assert execute('return document.querySelector("#window-close").getBoundingClientRect().right <= innerWidth')
        assert execute('return document.querySelector("#ide-navigation").hidden')
        assert execute('return document.querySelector("#preview-banner").hidden')
        assert execute('return document.documentElement.lang') == 'en'
        # A native popup action restores/focuses the window. It must not reveal
        # a second GTK menubar above the custom title bar.
        def assert_no_native_menubar():
            size = invoke('plugin:window|inner_size', {'label': 'main'})
            viewport = execute('return {width:innerWidth * devicePixelRatio, height:innerHeight * devicePixelRatio}')
            assert abs(size['height'] - viewport['height']) <= 1, (size, viewport)
            assert abs(size['width'] - viewport['width']) <= 1, (size, viewport)

        assert_no_native_menubar()
        click('[data-menu="file"]')
        # WebDriver key actions target WebKit, not GTK popup windows.
        x11 = ctypes.CDLL('libX11.so.6')
        xtest = ctypes.CDLL('libXtst.so.6')
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XKeysymToKeycode.restype = ctypes.c_uint
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        xtest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        display = x11.XOpenDisplay(None)
        assert display
        try:
            time.sleep(.2)
            for keysym in [0xff50, 0xff54, 0xff0d]:  # Home, Down, Return
                code = x11.XKeysymToKeycode(display, keysym)
                xtest.XTestFakeKeyEvent(display, code, 1, 0)
                xtest.XTestFakeKeyEvent(display, code, 0, 0)
                x11.XSync(display, 0)
                time.sleep(.1)
        finally:
            x11.XCloseDisplay(display)
        wait_for('document.querySelector("#modal").open')
        assert 'New workspace' in execute('return document.querySelector("#modal").textContent')
        click('#modal-cancel')
        assert_no_native_menubar()
        click('#window-maximize')
        assert_no_native_menubar()
        click('#window-maximize')
        assert_no_native_menubar()
        assert execute('return document.querySelector("#workspace-name").textContent') == 'Personal'
        assert execute('return document.querySelector("#add-project").textContent').strip() == 'Open folder'
        click('#new-workspace')
        input_text('#modal input[name="title"]', 'Test workspace')
        click('#modal button[type="submit"]')
        wait_for('!document.querySelector("#modal").open')
        assert execute('return document.querySelector("#workspace-name").textContent') == 'Test workspace'
        database = invoke('load_workspace')
        workspace = next(w for w in database['workspaces'] if w['name'] == 'Test workspace')
        assert set(workspace) == {'id', 'name'}
        assert set(database) == {'version', 'workspaces', 'projects'}
        database = invoke('add_project', {'workspaceId': workspace['id'], 'path': directory})
        registered = database['projects'][-1]
        second_path = project / 'another-project'
        second_path.mkdir()
        (second_path / 'second.txt').write_text('Second project')
        second_database = invoke('add_project', {'workspaceId': workspace['id'], 'path': str(second_path)})
        second_registered = second_database['projects'][-1]
        request('POST', f'/session/{SESSION}/refresh', {})
        enter_launcher()
        wait_for('document.querySelector(".project-card") !== null')
        click('.project-title')
        wait_for('document.querySelector(".file-button") !== null')
        assert execute('return document.querySelector(\'.file-button[title="main.rs"] > svg\').dataset.fileKind') == 'rust'
        assert execute('return document.querySelector(\'.file-button[title="example.py"] > svg\').dataset.fileKind') == 'python'
        assert execute('return document.querySelector(\'.file-button[title=".env"] > svg\').dataset.fileKind') == 'env'
        # Exercise DOM drag events through the real WebKit frontend and Rust filesystem.
        def drag_entry(source, target, copy=False):
            execute("""
                const source = document.querySelector(arguments[0]);
                const target = document.querySelector(arguments[1]);
                const dataTransfer = new DataTransfer();
                source.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer}));
                target.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer, ctrlKey:arguments[2]}));
                target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer, ctrlKey:arguments[2]}));
            """, source, target, copy)

        click('.file-button[title="transfer.txt"]')
        wait_for('document.querySelector("#code-editor .cm-content") !== null')
        input_text('#code-editor .cm-content', 'unsaved ')
        drag_entry('.file-button[title="transfer.txt"]', 'summary[title="transfer-target"]', True)
        wait_for("""document.querySelector('.file-button[title="transfer-target/transfer.txt"]') !== null""")
        assert (project / 'transfer-target/transfer.txt').read_text() == 'saved transfer content'
        assert (project / 'transfer.txt').exists()
        drag_entry('.file-button[title="transfer.txt"]', '#explorer-root', True)
        wait_for("""document.querySelector('.file-button[title="transfer copy.txt"]') !== null""")
        drag_entry('.file-button[title="transfer copy.txt"]', 'summary[title="transfer-target"]')
        wait_for("""document.querySelector('.file-button[title="transfer-target/transfer copy.txt"]') !== null""")
        assert not (project / 'transfer copy.txt').exists()
        # A collision leaves both source and destination untouched.
        drag_entry('.file-button[title="transfer.txt"]', 'summary[title="transfer-target"]')
        wait_for('document.querySelector("#toast").textContent.includes("already exists")')
        assert (project / 'transfer.txt').read_text() == 'saved transfer content'
        assert 'unsaved' in execute('return document.querySelector("#code-editor .cm-content").textContent')
        # Move the destination folder and ensure its expanded state is preserved.
        (project / 'outer').mkdir()
        click('#refresh-files')
        wait_for("""document.querySelector('summary[title="outer"]') !== null""")
        drag_entry('summary[title="transfer-target"]', 'summary[title="outer"]')
        wait_for("""document.querySelector('.file-button[title="outer/transfer-target/transfer.txt"]') !== null""")
        drag_entry('.file-button[title="transfer.txt"]', 'summary[title="outer"]')
        wait_for('document.querySelector("#editor-title").textContent.includes("outer/transfer.txt")')
        assert 'unsaved' in execute('return document.querySelector("#code-editor .cm-content").textContent')
        click('#save-file')
        wait_for('document.querySelector(".tab-dirty").hidden')
        assert 'unsaved' in (project / 'outer/transfer.txt').read_text()
        assert not (project / 'transfer.txt').exists()
        click('button[aria-label="Close outer/transfer.txt"]')
        def key(selector, key, ctrl=False, shift=False):
            execute("document.querySelector(arguments[0]).focus();", selector)
            value = {'F2': '\ue032'}.get(key, key)
            actions = []
            if ctrl: actions.append({'type': 'keyDown', 'value': '\ue009'})
            if shift: actions.append({'type': 'keyDown', 'value': '\ue008'})
            actions.extend([{'type': 'keyDown', 'value': value}, {'type': 'keyUp', 'value': value}])
            if shift: actions.append({'type': 'keyUp', 'value': '\ue008'})
            if ctrl: actions.append({'type': 'keyUp', 'value': '\ue009'})
            request('POST', f'/session/{SESSION}/actions', {'actions': [{'type': 'key', 'id': 'keyboard', 'actions': actions}]})

        # Multiple selection, clipboard shortcuts, and partial-operation reporting.
        click('.file-button[title="multi-a.txt"]')
        execute("document.querySelector('.file-button[title=\"multi-b.txt\"]').dispatchEvent(new MouseEvent('click', {ctrlKey:true, bubbles:true}));")
        assert execute('return document.querySelectorAll("#file-tree .selected").length') == 2
        key('.file-sidebar', 'c', True)
        click('summary[title="clipboard-target"]')
        key('.file-sidebar', 'v', True)
        wait_for("""document.querySelector('.file-button[title="clipboard-target/multi-b.txt"]') !== null""")
        assert (project / 'clipboard-target/multi-a.txt').read_text() == 'alpha'
        assert (project / 'clipboard-target/multi-b.txt').read_text() == 'beta'
        # A multiple-selection drag copies both source files.
        click('.file-button[title="multi-a.txt"]')
        execute("document.querySelector('.file-button[title=\"multi-b.txt\"]').dispatchEvent(new MouseEvent('click', {ctrlKey:true, bubbles:true}));")
        drag_entry('.file-button[title="multi-a.txt"]', 'summary[title="outer"]', True)
        wait_for("""document.querySelector('.file-button[title="outer/multi-b.txt"]') !== null""")
        assert (project / 'outer/multi-a.txt').read_text() == 'alpha'
        assert (project / 'outer/multi-b.txt').read_text() == 'beta'
        # F2 keeps unsaved text and refreshes syntax after the extension changes.
        click('.file-button[title="multi-a.txt"]')
        input_text('#code-editor .cm-content', 'unsaved ')
        click('.file-button[title="multi-a.txt"]')
        key('.file-sidebar', 'F2')
        wait_for('document.querySelector(".entry-name-input") !== null')
        execute('document.querySelector(".entry-name-input").value = "renamed.py";')
        click('.inline-name button[type="submit"]')
        wait_for('document.querySelector(".inline-name") === null')
        wait_for('document.querySelector("#status-file").textContent.includes("Python")')
        assert 'unsaved' in execute('return document.querySelector("#code-editor .cm-content").textContent')
        assert not (project / 'multi-a.txt').exists()
        key('.file-sidebar', 's', True)
        wait_for('document.querySelectorAll(".tab-dirty:not([hidden])").length === 0')
        assert 'unsaved' in (project / 'renamed.py').read_text()
        # Shared document updates across groups; closing the second group preserves tabs.
        click('#split-editor')
        wait_for('document.querySelector("#code-editor-secondary .cm-content") !== null')
        input_text('#code-editor-secondary .cm-content', 'shared ')
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("shared")')
        key('#code-editor-secondary .cm-content', 'z', True)
        wait_for('!document.querySelector("#code-editor .cm-content").textContent.includes("shared")')
        key('#code-editor-secondary .cm-content', 'z', True, True)
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("shared")')
        click('#save-secondary')
        wait_for('document.querySelectorAll(".tab-dirty:not([hidden])").length === 0')
        assert 'shared' in (project / 'renamed.py').read_text()
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/editor-split-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        for theme in ['Light', 'Dark']:
            click('#appearance-button')
            execute("[...document.querySelectorAll('.context-menu button')].find(button => button.textContent===arguments[0]).click();", theme)
            wait_for(f'document.documentElement.dataset.appearance === "{theme.lower()}"')
            expected_background = 'rgb(28, 28, 30)' if theme == 'Dark' else 'rgb(255, 255, 255)'
            wait_for(f'getComputedStyle(document.querySelector("#quick-open")).backgroundColor === "{expected_background}"')
            Path(f'/app/artifacts/editor-{theme.lower()}-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('#appearance-button')
        execute("[...document.querySelectorAll('.context-menu button')].find(button => button.textContent==='Light').click();")
        click('#close-group')
        assert execute("""return document.querySelector('[data-group="1"]').hidden""")
        click('button[aria-label="Close renamed.py"]')
        # Cut and paste move the file, preserving its saved contents.
        click('.file-button[title="renamed.py"]')
        key('.file-sidebar', 'x', True)
        assert execute('return document.querySelector(".cut-entry") !== null')
        click('summary[title="clipboard-target"]')
        key('.file-sidebar', 'v', True)
        wait_for("""document.querySelector('.file-button[title="clipboard-target/renamed.py"]') !== null""")
        assert not (project / 'renamed.py').exists()
        click('button[aria-label="Close clipboard-target/renamed.py"]')
        # Context menu creates a real folder without interpolating filenames into HTML.
        execute("document.querySelector('summary[title=\"clipboard-target\"]').dispatchEvent(new MouseEvent('contextmenu', {clientX:120, clientY:180, bubbles:true, cancelable:true}));")
        wait_for('document.querySelector(".context-menu") !== null')
        execute("[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent.includes('New Folder')).click();")
        input_text('.entry-name-input', 'new-folder')
        click('.inline-name button[type="submit"]')
        wait_for('document.querySelector(".inline-name") === null')
        assert (project / 'clipboard-target/new-folder').is_dir()
        wait_for("""document.querySelector('summary[title="clipboard-target/new-folder"]') !== null""")
        # Inline validation retains the name and allows correction or Escape.
        click('.file-button[title="multi-b.txt"]')
        key('.file-sidebar', 'F2')
        execute('document.querySelector(".entry-name-input").value = "main.rs";')
        click('.inline-name button[type="submit"]')
        wait_for('document.querySelector(".entry-name-input")?.getAttribute("aria-invalid") === "true"')
        assert (project / 'multi-b.txt').read_text() == 'beta'
        input_text('.entry-name-input', '\ue00c')
        wait_for('document.querySelector(".inline-name") === null')
        for theme in ['Dark', 'Light']:
            click('#appearance-button')
            execute("[...document.querySelectorAll('.context-menu button')].find(button => button.textContent===arguments[0]).click();", theme)
            wait_for(f'document.documentElement.dataset.appearance === "{theme.lower()}"')
            assert execute('return localStorage.getItem("aurea.appearance")') == theme.lower()
        assert execute('return document.querySelector("#ide-header").contains(document.querySelector("#ide-navigation"))')
        # Reorder pinned tabs and move a tab between editor groups.
        for name in ['multi-b.txt', 'example.py']:
            execute("document.querySelector(arguments[0]).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));", f'.file-button[title="{name}"]')
            wait_for(f'document.querySelector("#editor-title").textContent === "{name}"')
        execute("""
            const tabs = [...document.querySelectorAll('#editor-tabs .editor-tab')];
            const source = tabs.find(t=>t.querySelector('.tab-file-name').textContent==='example.py');
            const target = tabs.find(t=>t.querySelector('.tab-file-name').textContent==='multi-b.txt');
            const dataTransfer = new DataTransfer();
            source.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer}));
            target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer}));
        """)
        assert execute('return document.querySelector("#editor-tabs .tab-file-name").textContent') == 'example.py'
        execute("document.querySelector('#editor-tabs .editor-tab').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:400, clientY:100}));")
        execute("[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent==='Move to Right Group').click();")
        wait_for('document.querySelector("#editor-title-secondary").textContent === "example.py"')
        assert execute('return document.querySelector("#editor-tabs .tab-file-name").textContent') == 'multi-b.txt'
        click('#close-group')
        click('button[aria-label="Close example.py"]')
        click('button[aria-label="Close multi-b.txt"]')
        # Read-only images, safe SVG source/preview and paginated local PDFs.
        for name in ['preview.png', 'preview.webp', 'preview.svg']:
            print('Preview fixture:', name, flush=True)
            click(f'.file-button[title="{name}"]')
            wait_for('document.querySelector("#media-preview img")?.naturalWidth > 0')
            assert not execute('return Boolean(window.svgExecuted)')
            if name == 'preview.svg':
                assert execute('return !document.querySelector("#code-editor").hidden')
            else:
                assert execute('return document.querySelector("#code-editor").hidden')
            click(f'button[aria-label="Close {name}"]')
        click('.file-button[title="preview.pdf"]')
        wait_for('document.querySelector("#media-preview canvas")?.dataset.rendered === "true"', 30)
        assert 'Page 1 / 2' in execute('return document.querySelector("#media-preview").textContent')
        execute("[...document.querySelectorAll('#media-preview button')].find(b=>b.textContent==='Next page').click();")
        wait_for('document.querySelector("#media-preview canvas")?.getAttribute("aria-label") === "PDF page 2" && document.querySelector("#media-preview canvas")?.dataset.rendered === "true"')
        Path('/app/artifacts/pdf-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('button[aria-label="Close preview.pdf"]')
        click('#quick-open')
        wait_for('document.querySelectorAll("#quick-results button").length > 0')
        input_text('#quick-input', 'main.rs')
        wait_for('document.querySelectorAll("#quick-results button").length === 1')
        input_text('#quick-input', '\ue007')
        wait_for('document.querySelector("#editor-title").textContent === "main.rs"')
        assert execute('return document.querySelectorAll(".editor-tab.temporary").length') == 0
        click('button[aria-label="Close main.rs"]')
        click('#workspace-more')
        execute("[...document.querySelectorAll('.context-menu button')].find(button => button.textContent.includes('Browse all actions')).click();")
        wait_for('document.querySelectorAll("#quick-results button").length > 0')
        input_text('#quick-input', 'Toggle explorer')
        input_text('#quick-input', '\ue007')
        assert execute('return document.querySelector("#app").classList.contains("explorer-hidden")')
        click('#toggle-explorer')
        assert not execute('return document.querySelector("#app").classList.contains("explorer-hidden")')
        previous_width = execute('return document.querySelector(".file-sidebar").getBoundingClientRect().width')
        input_text('#explorer-resize', '\ue014')
        assert execute('return document.querySelector(".file-sidebar").getBoundingClientRect().width') > previous_width
        click('[data-page="database"]')
        wait_for('document.querySelector("#db-sql .cm-content") !== null')
        click('#db-new')
        input_text('#database-modal input[name="name"]', 'Fixture database')
        execute('const select = document.querySelector("#database-modal select[name=engine]"); select.value = "sqlite"; select.dispatchEvent(new Event("change"));')
        input_text('#database-modal input[name="database"]', 'fixture.db')
        click('#database-modal button[type="submit"]')
        wait_for('document.querySelector(".db-table") !== null')
        click('.db-table')
        wait_for('document.querySelector(".db-grid")?.textContent.includes("Alice")')
        assert execute('return document.querySelector(".db-grid td.null").textContent') == 'NULL'
        double_click('td[aria-label="Edit name, row 1"]')
        execute('document.querySelector("#database-modal textarea").value = "Updated Alice";')
        click('#database-modal button[type="submit"]')
        assert execute('return document.querySelector("td.pending").textContent') == 'Updated Alice'
        with sqlite3.connect(project / 'fixture.db') as database:
            assert database.execute('SELECT name FROM people').fetchone()[0] == 'Alice'
        click('#db-apply')
        click('#database-modal button[type="submit"]')
        wait_for('document.querySelector("#db-status").textContent.includes("rows updated")')
        with sqlite3.connect(project / 'fixture.db') as database:
            assert database.execute('SELECT name FROM people').fetchone()[0] == 'Updated Alice'
        click('#db-structure')
        assert 'Primary key' in execute('return document.querySelector(".db-grid").textContent')
        click('#db-data')
        input_text('#db-sql .cm-content', '\nSELECT id, name FROM people;')
        click('#db-run')
        wait_for('document.querySelector("#db-status").textContent.includes("Completed")')
        assert 'Updated Alice' in execute('return document.querySelector(".db-grid").textContent')
        assert execute('return document.querySelector("td.editable") === null')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/database-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('#db-save-sql')
        click('#database-modal button[type="submit"]')
        wait_for('document.querySelector("#db-status").textContent.includes("Saved query.sql")')
        assert 'SELECT id, name FROM people' in (project / 'query.sql').read_text()
        saved_connections = invoke('db_connections', {'projectId': registered['id']})
        assert saved_connections[0]['name'] == 'Fixture database'
        assert 'password' not in saved_connections[0]
        assert invoke('db_connections', {'projectId': second_registered['id']}) == []
        try:
            invoke('db_tables', {'projectId': second_registered['id'], 'connectionId': saved_connections[0]['id']})
            raise AssertionError('Foreign database connection was accepted')
        except AssertionError as error:
            assert 'Connection not found' in str(error), str(error)
        click('[data-page="editor"]')
        click('.file-button[title="README.md"]')
        wait_for('document.querySelector(".editor-tab.temporary") !== null')
        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#editor-title").textContent === "example.py"')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 1
        double_click('.file-button[title="example.py"]')
        wait_for('document.querySelectorAll(".editor-tab.temporary").length === 0')
        click('.file-button[title="main.rs"]')
        wait_for('document.querySelector("#editor-title").textContent === "main.rs"')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 2
        assert execute('return document.querySelectorAll(".editor-tab.temporary").length') == 1
        assert execute('return document.querySelector(".editor-tab.active .file-type-icon").dataset.fileKind') == 'rust'
        assert 'Hello Aurea' in execute('return document.querySelector("#code-editor .cm-content").textContent')
        input_text('#code-editor .cm-content', '// edited\n')
        wait_for('!document.querySelector("#save-file").disabled')
        wait_for('document.querySelectorAll(".editor-tab.temporary").length === 0')
        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#editor-title").textContent === "example.py"')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 2
        click('button[aria-label="Close main.rs"]')
        wait_for('document.querySelector("#discard-modal").open')
        click('#discard-cancel')
        wait_for('!document.querySelector("#discard-modal").open')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 2
        click('#back-launcher')
        wait_for('document.querySelector("#discard-modal").open')
        click('#discard-cancel')
        wait_for('!document.querySelector("#discard-modal").open')
        assert execute('return document.querySelector("#app").dataset.stage') == 'ide'
        click('.editor-tab-select[title="main.rs"]')
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("// edited")')
        assert not execute('return document.querySelector("#save-file").disabled')
        click('#save-file')
        wait_for('document.querySelectorAll(".tab-dirty:not([hidden])").length === 0')
        click('button[aria-label="Close example.py"]')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 1

        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#editor-title").textContent === "example.py"')
        input_text('#code-editor .cm-content', '# discarded edit\n')
        wait_for('!document.querySelector("#save-file").disabled')
        click('button[aria-label="Close example.py"]')
        wait_for('document.querySelector("#discard-modal").open')
        click('#discard-confirm')
        wait_for('document.querySelectorAll(".editor-tab").length === 1')
        assert '# discarded edit' not in (project / 'example.py').read_text()
        assert execute('return document.querySelector("#editor-title").textContent') == 'main.rs'
        assert '// edited' in (project / 'main.rs').read_text()
        (project / 'main.rs').write_text('// external synchronization\n')
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("external synchronization")')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/editor-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('.file-button[title="README.md"]')
        wait_for('!document.querySelector("#document-modes").hidden')
        click('[data-document-mode="split"]')
        wait_for('document.querySelector("#document-preview h1")?.textContent === "Project guide"')
        assert not execute('return document.querySelector("#code-editor").hidden')
        assert execute('return document.querySelector("#document-preview table") !== null')
        input_text('#code-editor .cm-content', 'Updated ')
        wait_for('document.querySelector("#document-preview").textContent.includes("Updated")')
        click('#save-file')
        wait_for('document.querySelectorAll(".tab-dirty:not([hidden])").length === 0')
        click('[data-document-mode="preview"]')
        assert execute('return document.querySelector("#code-editor").hidden')
        Path('/app/artifacts/document-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('[data-document-mode="code"]')
        assert execute('return document.querySelector("#document-preview").hidden')
        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#status-file").textContent.includes("Python")')
        wait_for('new Set([...document.querySelectorAll("#code-editor .cm-content span")].map(node => getComputedStyle(node).color)).size > 1')
        click('.file-button[title=".env"]')
        wait_for('document.querySelectorAll(".env-value-toggle").length === 3')
        assert 'TOKEN=' in execute('return document.querySelector("#code-editor .cm-content").textContent')
        assert 'test-secret' not in execute('return document.querySelector("#code-editor .cm-content").textContent')
        assert 'line-two' not in execute('return document.querySelector("#code-editor .cm-content").textContent')
        click('button[aria-label="Reveal value for TOKEN"]')
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("first-test-secret")')
        assert 'second-test-secret' not in execute('return document.querySelector("#code-editor .cm-content").textContent')
        click('button[aria-label="Hide value for TOKEN"]')
        wait_for('!document.querySelector("#code-editor .cm-content").textContent.includes("first-test-secret")')
        click('button[aria-label="Reveal value for MULTI"]')
        wait_for('document.querySelector("#code-editor .cm-content").textContent.includes("line-two")')
        click('#reload-file')
        wait_for('!document.querySelector("#code-editor .cm-content").textContent.includes("line-two")')
        assert execute('return document.querySelector("#save-file").disabled')
        assert (project / '.env').read_text() == env_content
        Path('/app/artifacts/env-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('[data-page="git"]')
        assert execute('return getComputedStyle(document.querySelector("#editor-page")).display') == 'none'
        assert execute('return document.querySelector("#editor-title").textContent.length > 0')
        wait_for('document.querySelector("#git-refresh") !== null')
        click('#git-refresh')
        wait_for('document.querySelector("#close-tool") !== null')
        click('#close-tool')
        assert execute('return document.querySelector("#page-content").hidden')
        click('[data-page="git"]')
        click('[data-page="git"]')
        wait_for('document.querySelector(".git-file-row") !== null')
        click('button[aria-label="Stage main.rs"]')
        wait_for("""document.querySelector('button[aria-label="Unstage main.rs"]') !== null""")
        click('button[aria-label="Unstage main.rs"]')
        wait_for("""document.querySelector('button[aria-label="Stage main.rs"]') !== null""")
        click('#git-stage')
        wait_for('document.querySelector("#git-stage") === null')
        input_text('#commit-message', 'test: verify desktop integration')
        click('#git-commit')
        wait_for('document.querySelector("#git-status")?.textContent.startsWith("0 changed files")')
        execute("[...document.querySelectorAll('.git-segments button')].find(b=>b.textContent.startsWith('History')).click();")
        wait_for('document.querySelector(".git-history-row") !== null')
        click('.git-history-row')
        wait_for('document.querySelector("#git-output")?.textContent.includes("diff --git")')
        Path('/app/artifacts/git-history-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        (project / 'stash-example.txt').write_text('saved stash contents')
        invoke('git_workspace_action', {'projectId': registered['id'], 'action': 'stash-save', 'target': '', 'message': 'Example stash'})
        wait_for('document.querySelector("#git-refresh") !== null')
        click('#git-refresh')
        execute("[...document.querySelectorAll('.git-segments button')].find(b=>b.textContent.startsWith('Stashes')).click();")
        wait_for('document.querySelector(".git-stash-row") !== null')
        click('.git-stash-row button:first-child')
        wait_for('document.querySelector("#git-output")?.textContent.includes("saved stash contents")')
        log = invoke('git_action', {'projectId': registered['id'], 'action': 'log'})
        assert 'test: verify desktop integration' in log
        click('#back-launcher')
        wait_for('document.querySelectorAll(".editor-tab").length === 0')
        click('.project-title')
        wait_for('document.querySelector("#start-shell")?.offsetParent !== null')
        click('.file-button[title="main.rs"]')
        wait_for('document.querySelector("#code-editor .cm-content") !== null')
        key('#code-editor .cm-content', 'j', True)
        wait_for('document.querySelector(".terminal-tab") !== null')
        terminal_count = execute('return document.querySelectorAll(".terminal-tab").length')
        click('#start-shell')
        wait_for('document.querySelector("#terminal-panel").hidden')
        click('#start-shell')
        wait_for('!document.querySelector("#terminal-panel").hidden')
        assert execute('return document.querySelectorAll(".terminal-tab").length') == terminal_count

        wait_for('document.querySelector(".xterm-screen") !== null')
        input_text('.xterm-helper-textarea', 'echo aurea-terminal-smoke\n')
        wait_for('document.querySelector("#terminal-panel").textContent.includes("aurea-terminal-smoke")')
        click('[data-page="docker"]')
        wait_for('document.querySelector("#docker-list").textContent.includes("Docker unavailable")')
        # A fixture CLI exercises native Docker routing without granting access to the host daemon.
        docker_fixture = Path('/usr/local/bin/docker')
        assert not docker_fixture.exists(), 'UI test requires an isolated image without Docker'
        docker_fixture.write_text('#!/usr/bin/env python3\nimport sys,json,os\n'
            + 'roots = ' + repr({'a' * 64: directory, 'b' * 64: str(second_path)}) + '\n'
            + """if sys.argv[1] == 'ps': print('\\n'.join(roots))
elif sys.argv[1] == 'inspect':
 key = sys.argv[-1]
 if 'directory' in sys.argv[3]:
  print(json.dumps({'id':key,'name':'/database-'+key[0],'image':'postgres:17-alpine','ports':{'5432/tcp':[{'HostIp':'127.0.0.1','HostPort':'15432'}]},'directory':roots[key]}))
 else:
  print(json.dumps({'ID':key,'Names':'container-'+key[0],'Image':'test-image','State':'running','Status':'running','Ports':'','labels':{'com.docker.compose.project.working_dir':roots[key]}}))
elif sys.argv[1] == 'logs': print('project logs')
elif sys.argv[1] == 'pull':
 assert sys.argv[2:] == ['postgres:17-alpine']
 print('Database client download fixture passed')
elif sys.argv[1] == 'run':
 assert '--detach' in sys.argv and '--pull=missing' in sys.argv
 assert 'fixture-password' not in ' '.join(sys.argv)
 assert 'com.docker.compose.project.working_dir='+roots['a'*64] in sys.argv
 assert 'dev.aurea.database=true' in sys.argv
 assert sys.argv[sys.argv.index('--volume')+1].startswith('aurea-db-')
 image = sys.argv[-1]
 prefix = {'postgres:17-alpine':'POSTGRES','mysql:8.4':'MYSQL','mariadb:11.4':'MARIADB'}[image]
 port = '5432' if prefix == 'POSTGRES' else '3306'
 assert sys.argv[sys.argv.index('--publish')+1] == '127.0.0.1:15432:'+port
 assert os.environ[prefix+'_PASSWORD'] == 'fixture-password'
 print('c'*64)
else: raise SystemExit('Unexpected mutation')
""")
        docker_fixture.chmod(0o755)
        detected = invoke('db_docker_containers', {'projectId': registered['id']})
        assert len(detected) == 1 and detected[0]['id'] == 'a' * 64
        for engine, version in [('postgres', '17-alpine'), ('mysql', '8.4'), ('mariadb', '11.4')]:
            created = invoke('db_create_server', {'projectId': registered['id'], 'request': {'engine': engine, 'version': version, 'port': 15432, 'database': 'fixture', 'username': 'app', 'password': 'fixture-password'}})
            assert 'created on 127.0.0.1:15432' in created
            assert 'Volume: aurea-db-' in created
        click('[data-page="database"]')
        wait_for('document.querySelector("#db-connections").value !== ""')
        click('#db-tools')
        execute('const engine = document.querySelector("#database-modal select[name=engine]"); engine.value = "postgres"; engine.dispatchEvent(new Event("change")); const source = document.querySelector("#database-modal select[name=source]"); source.value = "docker"; source.dispatchEvent(new Event("change"));')
        click('#database-modal button[type="submit"]')
        wait_for('document.querySelector("#database-modal select[name=action]") !== null')
        click('#database-modal button[type="submit"]')
        wait_for('document.querySelector("#terminal-panel").textContent.includes("Database client download fixture passed")')
        click('.terminal-tab:first-child')
        click('[data-page="docker"]')
        click('#docker-refresh')
        wait_for('document.querySelector(".container-row") !== null')
        assert 'container-a' in execute('return document.querySelector("#docker-list").textContent')
        assert 'container-b' not in execute('return document.querySelector("#docker-list").textContent')
        click('[data-docker-action="logs"]')
        wait_for('document.querySelector("#docker-output").textContent.includes("project logs")')
        try:
            invoke('docker_action', {'projectId': registered['id'], 'action': 'stop', 'container': 'b' * 64})
            raise AssertionError('Foreign Docker action was accepted')
        except AssertionError as error:
            assert 'does not belong' in str(error), str(error)
        input_text('.xterm-helper-textarea', 'exit\n')
        wait_for('document.querySelector(".terminal-tab").textContent.includes("closed")')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/ide-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('#back-launcher')
        assert execute('return document.querySelector(".terminal-tab") === null')
        click('.project-title[data-project="' + second_registered['id'] + '"]')
        wait_for('document.querySelector(".file-button")?.title === "second.txt"')
        assert execute('return document.querySelector(".terminal-tab") === null')
        click('[data-page="docker"]')
        wait_for('document.querySelector("#docker-list").textContent.includes("container-b")')
        assert 'container-a' not in execute('return document.querySelector("#docker-list").textContent')
        click('[data-page="git"]')
        wait_for('document.querySelector("#git-status")?.textContent.includes("Open the repository root")')
        click('#back-launcher')
        click('[data-page="settings"]')
        wait_for('document.querySelector(".tool-row") !== null')
        assert execute('return Array.from(document.querySelectorAll(".tool-row strong"), node => node.textContent)') == ['git', 'docker']
        assert sorted(tool['name'] for tool in invoke('tools_status')) == ['docker', 'git']
        assert 'Found' in execute('return document.querySelector(".tool-row").textContent')
        click('[data-page="projects"]')
        assert execute('return document.querySelector("#app").dataset.stage === "launcher"')
        time.sleep(.4)
        screenshot = request('GET', f'/session/{SESSION}/screenshot')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/desktop-preview.png').write_bytes(base64.b64decode(screenshot))
        print('Desktop smoke passed: no native menubar after popup/restore, app shortcuts, independent launcher/IDE, light/dark appearance, stable navigation, terminal toggle, inline validation/cancel, workspaces, explorer multi-selection/clipboard/drag-drop/rename, editor groups/reordering/shared undo, PNG/WebP/SVG/PDF previews, Git, PTY cleanup, two-project Docker scoping (fixture CLI), foreign action rejection, database queries/grid edits, Docker database command routing and tool detection.')
    except Exception:
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/desktop-failure.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        print(execute('return document.body.innerText'))
        raise
    finally:
        request('DELETE', f'/session/{SESSION}')
        if 'docker_fixture' in locals():
            docker_fixture.unlink(missing_ok=True)

# Exercise the separately packaged updater with networking disabled by the runner.
result = request('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': '/app/src-tauri/target/release/aurea-code'}}}})
SESSION = result['sessionId']
launched_pids = []
try:
    wait_for('document.querySelector("#actions") && !document.querySelector("#actions").hidden', timeout=25)
    assert execute('return document.title') == 'Aurea Code Updater'
    assert execute('return document.querySelector("#workspace-select") === null')
    assert 'Unable to check' in execute('return document.querySelector("#detail").textContent')
    Path('/app/artifacts/updater-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
    # Let WebDriver return before the updater hides its own window.
    execute("setTimeout(() => document.querySelector('#continue').click(), 200); return true;")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        launched_pids = []
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit():
                try:
                    if (entry / 'comm').read_text().strip() == 'aurea-ide':
                        launched_pids.append(int(entry.name))
                except (FileNotFoundError, PermissionError):
                    pass
        if launched_pids:
            break
        time.sleep(.1)
    assert launched_pids, 'Updater did not launch the independent IDE process'
    print('Standalone updater smoke passed: offline error, explicit fallback, separate IDE process.')
finally:
    request('DELETE', f'/session/{SESSION}')
    for pid in launched_pids:
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
