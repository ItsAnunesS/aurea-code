const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

// Publish only the signed assets downloaded from this workflow's successful build.
module.exports = async ({ github, context, version = process.env.RELEASE_VERSION, directory = 'artifacts' }) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const repo = context.repo;
  const tag = `v${version}`;
  const appimage = `Aurea-Code-${version}-x86_64.AppImage`;
  const names = [appimage, `${appimage}.sig`, `${appimage}.zsync`, 'SHA256SUMS-linux.txt', 'latest.json'];
  const available = readdirSync(directory);
  for (const name of names) {
    if (!available.includes(name) || !readFileSync(join(directory, name)).length) throw new Error(`Missing release asset: ${name}`);
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('Update manifest version mismatch.');
  const getOrMissing = async operation => {
    try { return (await operation()).data; } catch (error) { if (error.status === 404) return null; throw error; }
  };
  const existingTag = await getOrMissing(() => github.rest.git.getRef({ ...repo, ref: `tags/${tag}` }));
  if (existingTag) {
    let object = existingTag.object;
    while (object.type === 'tag') object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object;
    if (object.sha !== context.sha) throw new Error('Release tag belongs to a different commit.');
  }
  let release = await getOrMissing(() => github.rest.repos.getReleaseByTag({ ...repo, tag }));
  if (release && !release.draft) {
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
    if (!names.every(name => assets.some(asset => asset.name === name && asset.size > 0))) throw new Error('Published release is incomplete; refusing to replace public assets.');
    return;
  }
  if (!existingTag) await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha: context.sha });
  if (!release) release = (await github.rest.repos.createRelease({ ...repo, tag_name: tag, target_commitish: context.sha, name: `Aurea Code ${tag}`, draft: true, generate_release_notes: true })).data;
  const existingAssets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: release.id, per_page: 100 });
  for (const name of names) {
    const old = existingAssets.find(asset => asset.name === name);
    // Only draft assets may be replaced when resuming an interrupted upload.
    if (old) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: old.id });
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: release.id, name, data: readFileSync(join(directory, name)) });
  }
  await github.rest.repos.updateRelease({ ...repo, release_id: release.id, draft: false, make_latest: 'true' });
};
