import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextVersion, planVersion, stampVersion } from '../scripts/release-version.mjs';
import publishRelease from '../scripts/publish-release.cjs';

test('Conventional Commits select the highest semantic bump', () => {
  assert.equal(nextVersion('0.2.1', ['fix: editor', 'ci: caching']), '0.2.2');
  assert.equal(nextVersion('0.2.1', ['docs: help']), '0.2.2');
  assert.equal(nextVersion('0.2.1', ['feat(db): queries', 'fix: editor']), '0.3.0');
  assert.equal(nextVersion('0.2.1', ['feat(db)!: change protocol']), '1.0.0');
  assert.equal(nextVersion('1.2.3', ['refactor: protocol\n\nBREAKING CHANGE: incompatible']), '2.0.0');
  assert.equal(nextVersion('1.2.3', ['refactor: protocol\n\nBREAKING-CHANGE: incompatible']), '2.0.0');
  assert.equal(nextVersion('1.2.3', []), '1.2.3');
  assert.throws(() => nextVersion('../bad', ['fix: bug']));
});

test('version planning uses reachable release history and preserves tagged retries', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'aurea-version-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init'); git('config', 'user.name', 'Release Test'); git('config', 'user.email', 'release@example.invalid');
    writeFileSync(join(cwd, 'package.json'), '{"version":"0.2.1"}');
    git('add', '.'); git('commit', '-m', 'feat: initial'); git('tag', 'v0.2.1');
    assert.equal(planVersion(cwd), '0.2.1');
    git('commit', '--allow-empty', '-m', 'fix: editor');
    assert.equal(planVersion(cwd), '0.2.2');
    git('commit', '--allow-empty', '-m', 'feat(db): tables');
    assert.equal(planVersion(cwd), '0.3.0');
    git('tag', 'v0.3.0');
    assert.equal(planVersion(cwd), '0.3.0');
    git('checkout', '-b', 'unrelated'); git('commit', '--allow-empty', '-m', 'feat!: other'); git('tag', 'v9.0.0'); git('checkout', 'v0.3.0');
    assert.equal(planVersion(cwd), '0.3.0');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('version stamping aligns app manifests and lockfiles without changing dependencies', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'aurea-stamp-'));
  const files = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
  try {
    mkdirSync(join(cwd, 'src-tauri'));
    for (const file of files) writeFileSync(join(cwd, file), readFileSync(file));
    const originalLock = JSON.parse(readFileSync(join(cwd, 'package-lock.json')));
    stampVersion('1.2.3', cwd);
    for (const file of files.slice(0, 3)) assert.equal(JSON.parse(readFileSync(join(cwd, file))).version, '1.2.3');
    const updatedLock = JSON.parse(readFileSync(join(cwd, 'package-lock.json')));
    assert.equal(updatedLock.packages[''].version, '1.2.3');
    delete originalLock.packages['']; delete updatedLock.packages[''];
    assert.deepEqual(updatedLock.packages, originalLock.packages);
    assert.match(readFileSync(join(cwd, 'src-tauri/Cargo.toml'), 'utf8'), /^version = "1.2.3"/m);
    const lock = readFileSync(join(cwd, 'src-tauri/Cargo.lock'), 'utf8');
    assert.match(lock, /name = "aurea-code"\nversion = "1.2.3"/);
    assert.equal(lock.replace(/(name = "aurea-code"\nversion = ")[^"]+/, '$1VERSION'), readFileSync('src-tauri/Cargo.lock', 'utf8').replace(/(name = "aurea-code"\nversion = ")[^"]+/, '$1VERSION'));
    assert.throws(() => stampVersion('../bad', cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('only successful release-branch builds can publish their own Linux artifact', () => {
  const source = readFileSync('.github/workflows/build.yml', 'utf8');
  for (const newline of ['\n', '\r\n']) {
    const workflow = source.replace(/\r?\n/g, newline).replace(/\r\n/g, '\n');
    const publication = workflow.split('  publish:\n')[1];
    assert.match(publication, /needs: linux/);
    assert.match(publication, /if: github.ref == 'refs\/heads\/release' && github.event_name != 'pull_request'/);
    assert.match(publication, /name: linux-x86_64/);
    assert.doesNotMatch(publication, /run-id:|cargo |docker |npm run (?:build|tauri)/);
    assert.ok(publication.indexOf('actions/checkout@') >= 0);
    assert.ok(publication.indexOf('actions/checkout@') < publication.indexOf('actions/download-artifact@'));
    assert.match(publication, /node scripts\/sign-release.mjs/);
    assert.match(publication, /needs.linux.outputs.version/);
    assert.doesNotMatch(workflow, /windows-latest|^    tags:/m);
    assert.match(workflow, /cancel-in-progress: false/);
  }
});

async function publicationFixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'aurea-publish-'));
  const name = 'Aurea-Code-1.2.3-x86_64.AppImage';
  const names = [name, `${name}.sig`, `${name}.zsync`, 'SHA256SUMS-linux.txt', 'latest.json'];
  for (const file of names) writeFileSync(join(directory, file), file === 'latest.json' ? '{"version":"1.2.3"}' : 'fixture');
  const calls = [];
  let tag = null, release = null, assets = [], failUpload = false;
  const missing = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
  const github = { rest: { git: {
    getRef: async () => tag ? { data: tag } : missing(),
    createRef: async input => { calls.push('tag'); tag = { object: { type: 'commit', sha: input.sha } }; },
  }, repos: {
    getReleaseByTag: async () => release ? { data: release } : missing(),
    createRelease: async input => { calls.push('draft'); assert.equal(input.draft, true); release = { id: 1, draft: true }; return { data: release }; },
    listReleaseAssets: async () => {},
    uploadReleaseAsset: async input => { if (failUpload) throw new Error('Upload failed'); calls.push('upload'); assets.push({ id: assets.length + 1, name: input.name, size: input.data.length }); },
    deleteReleaseAsset: async input => { assets = assets.filter(asset => asset.id !== input.asset_id); },
    updateRelease: async input => { calls.push('publish'); assert.equal(input.draft, false); assert.equal(assets.length, 5); release.draft = false; },
  } }, paginate: async () => assets };
  const publish = () => publishRelease({ github, context: { repo: { owner: 'owner', repo: 'repo' }, sha: 'tested-sha' }, version: '1.2.3', directory });
  try { await run({ publish, calls, names, directory, setTag: value => { tag = value; }, setFail: value => { failUpload = value; } }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('publication creates a tag and draft, uploads all assets, then publishes; retries are idempotent', () => publicationFixture(async ({ publish, calls }) => {
  await publish();
  assert.deepEqual(calls, ['tag', 'draft', ...Array(5).fill('upload'), 'publish']);
  await publish();
  assert.equal(calls.length, 8);
}));
test('failed uploads leave a draft that can be resumed', () => publicationFixture(async ({ publish, calls, setFail }) => {
  setFail(true);
  await assert.rejects(publish(), /Upload failed/);
  assert.deepEqual(calls, ['tag', 'draft']);
  setFail(false);
  await publish();
  assert.equal(calls.at(-1), 'publish');
  assert.equal(calls.filter(value => value === 'tag').length, 1);
}));
test('publication rejects missing assets and tags pointing at different commits', () => publicationFixture(async ({ publish, calls, names, directory, setTag }) => {
  setTag({ object: { type: 'commit', sha: 'other-sha' } });
  await assert.rejects(publish(), /different commit/);
  assert.deepEqual(calls, []);
  rmSync(join(directory, names[0]));
  await assert.rejects(publish(), /Missing release asset/);
  assert.deepEqual(calls, []);
}));
