import { readFileSync } from 'node:fs';
const packageVersion = JSON.parse(readFileSync('package.json')).version;
const tauriVersion = JSON.parse(readFileSync('src-tauri/tauri.conf.json')).version;
const cargoVersion = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (new Set([packageVersion, tauriVersion, cargoVersion]).size !== 1) throw new Error('package.json, Cargo.toml and tauri.conf.json must have the same version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${packageVersion}`) throw new Error('The release tag must match the application version.');
console.log(`Version ${packageVersion} verified.`);
