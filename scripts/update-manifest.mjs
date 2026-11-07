export function updateManifest(version, assets, published = new Date().toISOString()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  const select = (pattern) => {
    const matches = assets.filter(asset => pattern.test(asset.name));
    if (matches.length !== 1 || !matches[0].signature?.trim()) throw new Error('Expected one signed installer per platform.');
    const asset = matches[0];
    if (!asset.name.includes(version)) throw new Error('Installer version does not match the release.');
    return { signature: asset.signature.trim(), url: `https://github.com/ItsAnunesS/aurea-code/releases/download/v${version}/${encodeURIComponent(asset.name)}` };
  };
  const linux = select(/-x86_64\.AppImage$/);
  const nsis = select(/_x64-setup\.exe$/);
  const msi = select(/_x64_en-US\.msi$/);
  return { version, pub_date: published, notes: `Aurea Code ${version}`, platforms: {
    'linux-x86_64': linux, 'linux-x86_64-appimage': linux,
    'windows-x86_64': nsis, 'windows-x86_64-nsis': nsis, 'windows-x86_64-msi': msi,
  } };
}
