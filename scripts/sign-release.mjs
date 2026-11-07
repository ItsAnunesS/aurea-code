import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateManifest } from './update-manifest.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  throw new Error('Configure the TAURI_SIGNING_PRIVATE_KEY GitHub Actions secret before publishing.');
}
const directory = process.argv[2] ?? 'artifacts';
const assets = readdirSync(directory).filter(name => /-x86_64\.AppImage$/.test(name));
const signed = assets.map(name => {
  const file = join(directory, name);
  const result = spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--app-version', version, file], { encoding: 'utf8', env: process.env });
  // Do not forward signing tool output: only public signatures belong in artifacts.
  if (result.error || result.status !== 0) throw new Error(`Unable to sign ${name}. Check the signing key and password.`);
  return { name, signature: readFileSync(`${file}.sig`, 'utf8') };
});
writeFileSync(join(directory, 'latest.json'), JSON.stringify(updateManifest(version, signed), null, 2) + '\n');
console.log(`Signed ${signed.length} installers and generated latest.json for ${version}.`);
