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
    subprocess.run(['git', 'init', '-q', directory], check=True)
    subprocess.run(['git', '-C', directory, 'config', 'user.name', 'Aurea Test'], check=True)
    subprocess.run(['git', '-C', directory, 'config', 'user.email', 'test@example.invalid'], check=True)
    result = request('POST', '/session', {'capabilities': {'alwaysMatch': {'tauri:options': {'application': '/app/src-tauri/target/release/aurea-code'}}}})
    SESSION = result['sessionId']
    try:
        wait_for('document.querySelector("#workspace-select option") !== null')
        assert execute('return document.querySelector("#preview-banner").hidden')
        click('#new-workspace')
        input_text('#modal input[name="title"]', 'Workspace de teste')
        click('#modal button[type="submit"]')
        wait_for('!document.querySelector("#modal").open')
        assert execute('return document.querySelector("#workspace-name").textContent') == 'Workspace de teste'
        click('[data-page="accounts"]')
        click('#new-profile')
        input_text('#modal input[name="title"]', 'Codex de teste')
        click('#modal button[type="submit"]')
        wait_for('document.querySelector(".account-card") !== null')
        database = invoke('load_workspace')
        workspace = next(w for w in database['workspaces'] if w['name'] == 'Workspace de teste')
        assert len(workspace['profile_ids']) == 1
        database = invoke('add_project', {'workspaceId': workspace['id'], 'path': directory})
        registered = database['projects'][-1]
        request('POST', f'/session/{SESSION}/refresh', {})
        wait_for('document.querySelector(".project-card") !== null')
        click('.project-title')
        wait_for('document.querySelector(".file-button") !== null')
        click('.file-button')
        wait_for('document.querySelector(".cm-content") !== null')
        assert 'Hello Aurea' in execute('return document.querySelector(".cm-content").textContent')
        input_text('.cm-content', '// edited\n')
        wait_for('!document.querySelector("#save-file").disabled')
        click('#save-file')
        wait_for('document.querySelector("#save-file").disabled')
        assert '// edited' in (project / 'main.rs').read_text()
        (project / 'main.rs').write_text('// external synchronization\n')
        wait_for('document.querySelector(".cm-content").textContent.includes("external synchronization")')
        click('#project-git')
        wait_for('document.querySelector("#git-status")?.textContent.includes("main.rs")')
        invoke('git_action', {'projectId': registered['id'], 'action': 'stage'})
        invoke('git_action', {'projectId': registered['id'], 'action': 'commit', 'message': 'test: verify desktop integration'})
        log = invoke('git_action', {'projectId': registered['id'], 'action': 'log'})
        assert 'test: verify desktop integration' in log
        click('[data-page="projects"]')
        click('.project-title')
        wait_for('document.querySelector("#start-shell")?.offsetParent !== null')
        click('#start-shell')
        wait_for('document.querySelector(".xterm-screen") !== null')
        input_text('.xterm-helper-textarea', 'echo aurea-terminal-smoke\n')
        wait_for('document.querySelector("#terminal-panel").textContent.includes("aurea-terminal-smoke")')
        click('[data-page="docker"]')
        wait_for('document.querySelector("#docker-list").textContent.includes("Docker indisponível")')
        click('[data-page="settings"]')
        wait_for('document.querySelector(".tool-row") !== null')
        assert 'Encontrado' in execute('return document.querySelector(".tool-row").textContent')
        click('[data-page="projects"]')
        click('#hide-terminal')
        time.sleep(.4)
        screenshot = request('GET', f'/session/{SESSION}/screenshot')
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/desktop-preview.png').write_bytes(base64.b64decode(screenshot))
        print('Desktop smoke passed: workspace, account, project, editor save/sync, real Git commit, real PTY, unavailable Docker and tool detection.')
    except Exception:
        Path('/app/artifacts').mkdir(exist_ok=True)
        Path('/app/artifacts/desktop-failure.png').write_bytes(base64.b64decode(request('GET', f'/session/{SESSION}/screenshot')))
        print(execute('return document.body.innerText'))
        raise
    finally:
        request('DELETE', f'/session/{SESSION}')
