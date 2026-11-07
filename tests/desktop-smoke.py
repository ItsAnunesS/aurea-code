"""End-to-end smoke test against a real Tauri WebKit window (tauri-driver on port 4444).

Run only in an isolated container: the test creates a temporary project and workspace.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
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
    (project / 'main.rs').write_text('fn main() { println!("Hello Aurea"); }\n')
    (project / 'README.md').write_text('# Project guide\n\n**Hello documentation**\n\n| Tool | State |\n| --- | --- |\n| IDE | Ready |\n')
    env_content = 'TOKEN=first-test-secret\nPASSWORD="second-test-secret"\nMULTI="line-one\nline-two"\n'
    (project / '.env').write_text(env_content)
    (project / 'example.py').write_text('def greet(name):\n    return "Hello " + name # greeting\n')
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
        assert execute('return document.querySelector("#workspace-name").textContent') == 'Personal'
        assert execute('return document.querySelector("#add-project").textContent').strip() == 'Open folder'
        click('#new-workspace')
        input_text('#modal input[name="title"]', 'Test workspace')
        click('#modal button[type="submit"]')
        wait_for('!document.querySelector("#modal").open')
        assert execute('return document.querySelector("#workspace-name").textContent') == 'Test workspace'
        click('[data-page="accounts"]')
        click('#new-profile')
        input_text('#modal input[name="title"]', 'Test Codex')
        click('#modal button[type="submit"]')
        wait_for('document.querySelector(".account-card") !== null')
        database = invoke('load_workspace')
        workspace = next(w for w in database['workspaces'] if w['name'] == 'Test workspace')
        assert len(workspace['profile_ids']) == 1
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
        assert 'Hello Aurea' in execute('return document.querySelector(".cm-content").textContent')
        input_text('.cm-content', '// edited\n')
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
        wait_for('document.querySelector(".cm-content").textContent.includes("// edited")')
        assert not execute('return document.querySelector("#save-file").disabled')
        click('#save-file')
        wait_for('document.querySelector("#save-file").disabled')
        click('button[aria-label="Close example.py"]')
        assert execute('return document.querySelectorAll(".editor-tab").length') == 1

        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#editor-title").textContent === "example.py"')
        input_text('.cm-content', '# discarded edit\n')
        wait_for('!document.querySelector("#save-file").disabled')
        click('button[aria-label="Close example.py"]')
        wait_for('document.querySelector("#discard-modal").open')
        click('#discard-confirm')
        wait_for('document.querySelectorAll(".editor-tab").length === 1')
        assert '# discarded edit' not in (project / 'example.py').read_text()
        assert execute('return document.querySelector("#editor-title").textContent') == 'main.rs'
        assert '// edited' in (project / 'main.rs').read_text()
        (project / 'main.rs').write_text('// external synchronization\n')
        wait_for('document.querySelector(".cm-content").textContent.includes("external synchronization")')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/editor-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('.file-button[title="README.md"]')
        wait_for('!document.querySelector("#document-modes").hidden')
        click('[data-document-mode="split"]')
        wait_for('document.querySelector("#document-preview h1")?.textContent === "Project guide"')
        assert not execute('return document.querySelector("#code-editor").hidden')
        assert execute('return document.querySelector("#document-preview table") !== null')
        input_text('.cm-content', 'Updated ')
        wait_for('document.querySelector("#document-preview").textContent.includes("Updated")')
        click('#save-file')
        wait_for('document.querySelector("#save-file").disabled')
        click('[data-document-mode="preview"]')
        assert execute('return document.querySelector("#code-editor").hidden')
        Path('/app/artifacts/document-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('[data-document-mode="code"]')
        assert execute('return document.querySelector("#document-preview").hidden')
        click('.file-button[title="example.py"]')
        wait_for('document.querySelector("#status-file").textContent.includes("Python")')
        wait_for('new Set([...document.querySelectorAll(".cm-content span")].map(node => getComputedStyle(node).color)).size > 1')
        click('.file-button[title=".env"]')
        wait_for('document.querySelectorAll(".env-value-toggle").length === 3')
        assert 'TOKEN=' in execute('return document.querySelector(".cm-content").textContent')
        assert 'test-secret' not in execute('return document.querySelector(".cm-content").textContent')
        assert 'line-two' not in execute('return document.querySelector(".cm-content").textContent')
        click('button[aria-label="Reveal value for TOKEN"]')
        wait_for('document.querySelector(".cm-content").textContent.includes("first-test-secret")')
        assert 'second-test-secret' not in execute('return document.querySelector(".cm-content").textContent')
        click('button[aria-label="Hide value for TOKEN"]')
        wait_for('!document.querySelector(".cm-content").textContent.includes("first-test-secret")')
        click('button[aria-label="Reveal value for MULTI"]')
        wait_for('document.querySelector(".cm-content").textContent.includes("line-two")')
        click('#reload-file')
        wait_for('!document.querySelector(".cm-content").textContent.includes("line-two")')
        assert execute('return document.querySelector("#save-file").disabled')
        assert (project / '.env').read_text() == env_content
        Path('/app/artifacts/env-preview.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        click('[data-page="git"]')
        wait_for('document.querySelector("#git-status")?.textContent.includes("main.rs")')
        invoke('git_action', {'projectId': registered['id'], 'action': 'stage'})
        invoke('git_action', {'projectId': registered['id'], 'action': 'commit', 'message': 'test: verify desktop integration'})
        log = invoke('git_action', {'projectId': registered['id'], 'action': 'log'})
        assert 'test: verify desktop integration' in log
        click('#back-launcher')
        wait_for('document.querySelectorAll(".editor-tab").length === 0')
        click('.project-title')
        wait_for('document.querySelector("#start-shell")?.offsetParent !== null')
        click('#start-shell')
        wait_for('document.querySelector(".xterm-screen") !== null')
        input_text('.xterm-helper-textarea', 'echo aurea-terminal-smoke\n')
        wait_for('document.querySelector("#terminal-panel").textContent.includes("aurea-terminal-smoke")')
        click('[data-page="docker"]')
        wait_for('document.querySelector("#docker-list").textContent.includes("Docker unavailable")')
        # A fixture CLI exercises native Docker routing without granting access to the host daemon.
        docker_fixture = Path('/usr/local/bin/docker')
        assert not docker_fixture.exists(), 'UI test requires an isolated image without Docker'
        docker_fixture.write_text('#!/usr/bin/env python3\nimport sys,json\n'
            + 'roots = ' + repr({'a' * 64: directory, 'b' * 64: str(second_path)}) + '\n'
            + "if sys.argv[1] == 'ps': print('\\n'.join(roots))\n"
            + "elif sys.argv[1] == 'inspect':\n"
            + " key = sys.argv[-1]; print(json.dumps({'ID':key,'Names':'container-'+key[0],'Image':'test-image','State':'running','Status':'running','Ports':'','labels':{'com.docker.compose.project.working_dir':roots[key]}}))\n"
            + "elif sys.argv[1] == 'logs': print('project logs')\n"
            + "else: raise SystemExit('Unexpected mutation')\n")
        docker_fixture.chmod(0o755)
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
        wait_for('document.querySelector("#git-status").textContent.includes("Open the repository root")')
        click('#back-launcher')
        click('[data-page="settings"]')
        wait_for('document.querySelector(".tool-row") !== null')
        assert 'Found' in execute('return document.querySelector(".tool-row").textContent')
        click('[data-page="projects"]')
        assert execute('return document.querySelector("#app").dataset.stage === "launcher"')
        time.sleep(.4)
        screenshot = request('GET', f'/session/{SESSION}/screenshot')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/desktop-preview.png').write_bytes(base64.b64decode(screenshot))
        print('Desktop smoke passed: independent launcher/IDE, workspaces, accounts, editor, Git, PTY cleanup, two-project Docker scoping (fixture CLI), foreign action rejection and tool detection.')
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
