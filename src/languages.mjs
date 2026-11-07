import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { isEnvFile } from './env-values.mjs';

export function languageFor(path) {
  const filename = path.split(/[\\/]/).pop();
  if (isEnvFile(path)) return LanguageDescription.matchLanguageName(languages, 'Shell', false);
  const aliases = { mts: 'TypeScript', cts: 'TypeScript' };
  const extension = filename.split('.').pop().toLowerCase();
  if (extension in aliases) return LanguageDescription.matchLanguageName(languages, aliases[extension], false);
  return LanguageDescription.matchFilename(languages, filename)
    ?? LanguageDescription.matchFilename(languages, filename.toLowerCase());
}
