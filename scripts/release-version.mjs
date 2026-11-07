import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function nextVersion(base, messages) {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error('Invalid base version.');
  if (!messages.length) return base;
  const parts = base.split('.').map(Number);
  const breaking = messages.some(message => /^[a-z]+(?:\([^\r\n]+\))?!:/m.test(message) || /^BREAKING[ -]CHANGE:\s/m.test(message));
  const feature = messages.some(message => /^feat(?:\([^\r\n]+\))?:/m.test(message));
  if (breaking) return `${parts[0] + 1}.0.0`;
  if (feature) return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function planVersion(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tags = git('tag', '--merged', 'HEAD', '--sort=-version:refname').split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag));
  const latest = tags[0];
  // A retry of an already tagged commit must use the same embedded version.
  if (latest && git('rev-parse', `${latest}^{commit}`) === git('rev-parse', 'HEAD')) return latest.slice(1);
  const messages = git('log', '--format=%B%x00', latest ? `${latest}..HEAD` : 'HEAD').split('\0').map(value => value.trim()).filter(Boolean);
  const base = latest?.slice(1) ?? JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8')).version;
  return nextVersion(base, messages);
}

export function stampVersion(version, cwd = process.cwd()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const path = `${cwd}/${file}`;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.version = version;
    if (file === 'package-lock.json') data.packages[''].version = version;
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const path = `${cwd}/${file}`;
    const source = readFileSync(path, 'utf8');
    const pattern = file.endsWith('.toml') ? /(^version = ")[^"]+("\r?$)/m : /(\[\[package\]\]\r?\nname = "aurea-code"\r?\nversion = ")[^"]+("\r?$)/m;
    if (!pattern.test(source)) throw new Error(`Application version missing in ${file}.`);
    writeFileSync(path, source.replace(pattern, (_, prefix, suffix) => `${prefix}${version}${suffix}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? planVersion();
  stampVersion(version);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Release version: ${version}`);
}
