import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import findBuild from '../scripts/find-release-build.cjs';
const valid = { id: 42, head_sha: 'verified-sha', head_branch: 'release', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'owner/repo' } };
const assets = ['linux-x86_64'].map(name => ({ name, expired: false, size_in_bytes: 10 }));
async function resolve(snapshots, artifacts = assets) {
  let output, calls = 0, waits = 0;
  await findBuild({ context: { repo: { owner: 'owner', repo: 'repo' }, sha: 'verified-sha' },
    core: { setOutput: (_, value) => { output = value; }, info() {} },
    github: { rest: { actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: snapshots[Math.min(calls++, snapshots.length - 1)] } }), listWorkflowRunArtifacts() {} } }, paginate: async () => artifacts },
    wait: async ms => { assert.equal(ms, 30_000); waits++; }, maxAttempts: 4,
  });
  return { output, calls, waits };
}
test('release reuses complete successful builds of the exact release commit', async () => {
  assert.deepEqual(await resolve([[valid]]), { output: '42', calls: 1, waits: 0 });
});
test('simultaneous branch and tag pushes wait for the existing build', async () => {
  assert.deepEqual(await resolve([[], [{ ...valid, status: 'queued', conclusion: null }], [{ ...valid, status: 'in_progress', conclusion: null }], [valid]]), { output: '42', calls: 4, waits: 3 });
});
test('missing, failed, or expired builds block publication instead of compiling again', async () => {
  for (const change of [{ head_sha: 'older-sha' }, { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }, { head_repository: { full_name: 'fork/repo' } }]) {
    await assert.rejects(resolve([[{ ...valid, ...change }]]), /Tags never start a second build/);
  }
  await assert.rejects(resolve([[valid]], [{ ...assets[0], name: 'windows-x86_64' }]), /No complete successful build/);
  await assert.rejects(resolve([[]]), /No complete successful build/);
  await assert.rejects(resolve([[valid]], []), /No complete successful build/);
  await assert.rejects(resolve([[valid]], assets.map(a => ({ ...a, expired: true }))), /No complete successful build/);
  await assert.rejects(resolve([[valid]], assets.map(a => ({ ...a, size_in_bytes: 0 }))), /No complete successful build/);
});
function assertPublicationOrder(source) {
  const publication = source.replace(/\r\n/g, '\n').match(/^  publish:\n((?:    .*\n|\n)*)/m)?.[1];
  assert.ok(publication, 'Publication job must exist.');
  const checkout = publication.indexOf('actions/checkout@');
  const download = publication.indexOf('actions/download-artifact@');
  assert.ok(checkout >= 0, 'Publication must check out the release scripts.');
  assert.ok(download >= 0, 'Publication must download the verified installers.');
  assert.ok(checkout < download, 'Checkout must not clean already-downloaded installers.');
}
test('tag publication has no compilation jobs or fallback artifact source', () => {
  const build = readFileSync('.github/workflows/build.yml', 'utf8');
  const publish = readFileSync('.github/workflows/publish.yml', 'utf8');
  assert.doesNotMatch(build, /windows-latest|windows-x86_64|^  windows:/m);
  assert.match(publish, /name: linux-x86_64/);
  assert.doesNotMatch(publish, /pattern:|windows-x86_64/);
  assert.doesNotMatch(build.split('\npermissions:')[0], /tags:/);
  assert.doesNotMatch(publish, /cargo |npm run (?:build|tauri[^\n]*build)|docker (?:compose|build)|workflow_dispatch:/);
  assert.match(publish, /node scripts\/sign-release\.mjs/);
  assertPublicationOrder(publish);
  assert.match(publish, /run-id: \$\{\{ needs\.resolve\.outputs\.run_id \}\}/);
});
test('publication ordering supports LF and CRLF and rejects missing or reversed steps', () => {
  const publication = '  publish:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/download-artifact@v4\n';
  for (const newline of ['\n', '\r\n']) {
    const source = publication.replace(/\n/g, newline);
    assertPublicationOrder(source);
    assert.throws(() => assertPublicationOrder(source.replace('  publish:', '  other:')), /Publication job must exist/);
    assert.throws(() => assertPublicationOrder(source.replace('actions/checkout@', 'missing@')), /must check out/);
    assert.throws(() => assertPublicationOrder(source.replace('actions/download-artifact@', 'missing@')), /must download/);
    assert.throws(() => assertPublicationOrder(source.replace(/actions\/(checkout|download-artifact)@/g, (_, action) => action === 'checkout' ? 'actions/download-artifact@' : 'actions/checkout@')), /Checkout must not clean/);
    assert.throws(() => assertPublicationOrder(`  publish:${newline}    steps: []${newline}  other:${newline}${source.split(newline).slice(1).join(newline)}`), /must check out/);
  }
});
