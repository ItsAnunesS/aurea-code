// Reuse only complete, successful push builds of this exact commit on release.
module.exports = async ({ github, context, core }) => {
  const repo = context.repo;
  const { data: { workflow_runs: runs } } = await github.rest.actions.listWorkflowRuns({
    ...repo, workflow_id: 'build.yml', branch: 'release', event: 'push',
    head_sha: context.sha, status: 'success', per_page: 100,
  });
  for (const run of runs) {
    if (run.head_sha !== context.sha || run.head_branch !== 'release' ||
        run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'success' ||
        run.head_repository?.full_name !== `${repo.owner}/${repo.repo}`) continue;
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
    if (!['linux-x86_64', 'windows-x86_64'].every(name => artifacts.some(artifact =>
      artifact.name === name && !artifact.expired && artifact.size_in_bytes > 0))) continue;
    core.setOutput('run_id', String(run.id));
    core.info(`Reusing verified build ${run.id} for ${context.sha}.`);
    return;
  }
  core.setOutput('run_id', '');
  core.info('No complete verified build found; both platforms will be built and tested.');
};
