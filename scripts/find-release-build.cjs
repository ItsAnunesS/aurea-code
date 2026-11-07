// Tags only publish artifacts; compilation belongs exclusively to build.yml.
module.exports = async ({ github, context, core, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAttempts = 60 }) => {
  const repo = context.repo;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: { workflow_runs: runs } } = await github.rest.actions.listWorkflowRuns({
      ...repo, workflow_id: 'build.yml', branch: 'release', event: 'push',
      head_sha: context.sha, per_page: 100,
    });
    const candidates = runs.filter(run => run.head_sha === context.sha &&
      run.head_branch === 'release' && run.event === 'push' &&
      run.head_repository?.full_name === `${repo.owner}/${repo.repo}`);
    for (const run of candidates) {
      if (run.status !== 'completed' || run.conclusion !== 'success') continue;
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: run.id, per_page: 100 });
      if (!['linux-x86_64', 'windows-x86_64'].every(name => artifacts.some(artifact =>
        artifact.name === name && !artifact.expired && artifact.size_in_bytes > 0))) continue;
      core.setOutput('run_id', String(run.id));
      core.info(`Reusing verified build ${run.id} for ${context.sha}.`);
      return;
    }
    const pending = candidates.some(run => run.status !== 'completed');
    // Allow branch and tag pushes to arrive together before the branch run is visible.
    const awaitingRun = candidates.length === 0 && attempt < 2;
    if ((!pending && !awaitingRun) || attempt === maxAttempts - 1) break;
    core.info(`Waiting for Desktop builds on release at ${context.sha} (${attempt + 1}/${maxAttempts}).`);
    await wait(30_000);
  }
  throw new Error(`No complete successful build is available for ${context.sha}. Push this commit to release, complete Desktop builds (rerun it if artifacts expired), then rerun Publish release. Tags never start a second build.`);
};
