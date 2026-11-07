import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import findBuild from '../scripts/find-release-build.cjs';
const valid = { id: 42, head_sha: 'verified-sha', head_branch: 'release', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'owner/repo' } };
const assets = ['linux-x86_64', 'windows-x86_64'].map(name => ({ name, expired: false, size_in_bytes: 10 }));
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
  await assert.rejects(resolve([[]]), /No complete successful build/);
  await assert.rejects(resolve([[valid]], assets.slice(0, 1)), /No complete successful build/);
  await assert.rejects(resolve([[valid]], assets.map(a => ({ ...a, expired: true }))), /No complete successful build/);
  await assert.rejects(resolve([[valid]], assets.map(a => ({ ...a, size_in_bytes: 0 }))), /No complete successful build/);
});
test('tag publication has no compilation jobs or fallback artifact source', () => {
  const build = readFileSync('.github/workflows/build.yml', 'utf8');
  const publish = readFileSync('.github/workflows/publish.yml', 'utf8');
  assert.doesNotMatch(build.split('\npermissions:')[0], /tags:/);
  assert.doesNotMatch(publish, /cargo |npm run (?:build|tauri[^\n]*build)|docker (?:compose|build)|workflow_dispatch:/);
  assert.match(publish, /node scripts\/sign-release\.mjs/);
  const publication = publish.slice(publish.indexOf('  publish:\n'));
  assert.ok(publication.indexOf('actions/checkout@') < publication.indexOf('actions/download-artifact@'), 'Checkout must not clean already-downloaded installers.');
  assert.match(publish, /run-id: \$\{\{ needs\.resolve\.outputs\.run_id \}\}/);
});
