import test from 'node:test';
import assert from 'node:assert/strict';
import findBuild from '../scripts/find-release-build.cjs';
const valid = { id: 42, head_sha: 'verified-sha', head_branch: 'release', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'owner/repo' } };
const assets = ['linux-x86_64', 'windows-x86_64'].map(name => ({ name, expired: false, size_in_bytes: 10 }));
async function resolve(runs, artifacts = assets) {
  let output;
  await findBuild({ context: { repo: { owner: 'owner', repo: 'repo' }, sha: 'verified-sha' },
    core: { setOutput: (_, value) => { output = value; }, info() {} },
    github: { rest: { actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }), listWorkflowRunArtifacts() {} } }, paginate: async () => artifacts },
  });
  return output;
}
test('release reuses complete successful builds of the exact release commit', async () => {
  assert.equal(await resolve([valid]), '42');
});
test('release rebuilds when provenance, status, or artifacts do not match', async () => {
  for (const change of [{ head_sha: 'older-sha' }, { head_branch: 'feature' }, { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }, { head_repository: { full_name: 'fork/repo' } }]) {
    assert.equal(await resolve([{ ...valid, ...change }]), '');
  }
  assert.equal(await resolve([]), '');
  assert.equal(await resolve([valid], assets.slice(0, 1)), '');
  assert.equal(await resolve([valid], assets.map(a => ({ ...a, expired: true }))), '');
  assert.equal(await resolve([valid], assets.map(a => ({ ...a, size_in_bytes: 0 }))), '');
});
