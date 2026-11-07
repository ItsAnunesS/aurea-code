const endpoint = 'https://api.github.com/repos/ItsAnunesS/aurea-code/releases/latest';
export function isNewerVersion(current, candidate) {
  const parse = value => /^v?\d+\.\d+\.\d+$/.test(value) ? value.replace(/^v/, '').split('.').map(BigInt) : null;
  const left = parse(current), right = parse(candidate);
  if (!left || !right) throw new Error('Invalid release version.');
  for (let index = 0; index < 3; index++) {
    if (right[index] !== left[index]) return right[index] > left[index];
  }
  return false;
}
/** @param {string} current @param {typeof fetch} fetchRelease @param {AbortSignal | undefined} signal */
export async function checkRelease(current, fetchRelease = fetch, signal = undefined) {
  const response = await fetchRelease(endpoint, { signal, credentials: 'omit', cache: 'no-cache', headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub unavailable (${response.status}).`);
  const release = await response.json();
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string') throw new Error('Invalid release response.');
  return { version: release.tag_name, available: isNewerVersion(current, release.tag_name) };
}
