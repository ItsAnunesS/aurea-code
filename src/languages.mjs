import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { isEnvFile } from './env-values.mjs';

export function languageFor(path, source = '') {
  const filename = path.split(/[\\/]/).pop();
  const named = name => LanguageDescription.matchLanguageName(languages, name, false);
  if (isEnvFile(path)) return named('Shell');
  const lower = filename.toLowerCase();
  const special = { '.bashrc': 'Shell', '.bash_profile': 'Shell', '.zshrc': 'Shell', '.zprofile': 'Shell', '.profile': 'Shell', '.gitconfig': 'Properties files', '.editorconfig': 'Properties files', '.npmrc': 'Properties files', '.yarnrc': 'Properties files', 'justfile': 'Shell', 'jenkinsfile': 'Groovy', 'gemfile': 'Ruby', 'rakefile': 'Ruby', 'guardfile': 'Ruby', 'vagrantfile': 'Ruby', 'containerfile': 'Dockerfile', 'nginx.conf': 'Nginx', 'cmakelists.txt': 'CMake' };
  if (Object.hasOwn(special, lower)) return named(special[lower]);
  if (/^(dockerfile|containerfile)(\.|$)/.test(lower)) return named('Dockerfile');
  const aliases = { mts: 'TypeScript', cts: 'TypeScript', mjs: 'JavaScript', cjs: 'JavaScript', jsonc: 'JSON', json5: 'JSON', svg: 'XML', xsd: 'XML', xsl: 'XML', csproj: 'XML', fsproj: 'XML', props: 'XML', targets: 'XML', mdx: 'Markdown', pyi: 'Python', pyw: 'Python', kts: 'Kotlin', psm1: 'PowerShell', psd1: 'PowerShell', svelte: 'HTML', astro: 'HTML', avsc: 'JSON', ipynb: 'JSON' };
  const extension = lower.split('.').pop();
  if (Object.hasOwn(aliases, extension)) return named(aliases[extension]);
  const detected = LanguageDescription.matchFilename(languages, filename) ?? LanguageDescription.matchFilename(languages, lower);
  if (detected) return detected;
  const shebang = source.slice(0, 200).split('\n')[0];
  if (shebang.startsWith('#!')) {
    if (/\bpython[\d.]*\b/.test(shebang)) return named('Python');
    if (/\b(node|nodejs|deno|bun)\b/.test(shebang)) return named('JavaScript');
    if (/\b(bash|sh|zsh|fish|dash|ksh)\b/.test(shebang)) return named('Shell');
    if (/\bruby\b/.test(shebang)) return named('Ruby');
    if (/\bperl\b/.test(shebang)) return named('Perl');
  }
  return null;
}
