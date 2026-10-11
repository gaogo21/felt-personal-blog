import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const records = [], notices = new Map();
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  const packagePath = resolve(root, path, 'package.json');
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : null;
  const name = pkg?.name || path.slice(path.lastIndexOf('node_modules/') + 13);
  if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error(`Unexpected package source: ${name}`);
  records.push({ name, version: entry.version, license: pkg?.license || entry.license || 'SEE LICENSE', developmentOnly: entry.dev === true,
    source: entry.resolved, integrity: entry.integrity, installed: Boolean(pkg) });
  if (!pkg || entry.dev) continue;
  const directory = resolve(root, path);
  const license = readdirSync(directory).find(file => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(file));
  if (!license) throw new Error(`Missing runtime license text: ${name}`);
  const contents = readFileSync(resolve(directory, license), 'utf8').trim();
  const prior = notices.get(contents) || [];
  prior.push(`${name}@${entry.version}`); notices.set(contents, prior);
}
records.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
writeFileSync(resolve(root, 'package-licenses.json'), `${JSON.stringify(records, null, 2)}\n`);
const allNotices = [...notices].map(([license, packages]) => `${packages.join('\n')}\n\n${license}`).join('\n\n---\n\n');
const evidence = '# Editor dependency licenses\n\n' +
  'Generated from the locked npm packages and their installed license files. ' +
  'Only open-source editor extensions are enabled. No React, Pro packages or runtime CDN is used. ' +
  'package-licenses.json records the exact complete locked dependency list, including build/test and optional platform packages. ' +
  'Runtime license texts below are also included in the generated JavaScript bundle.\n\n' +
  'Official references:\n\n' +
  '- https://tiptap.dev/docs/editor/getting-started/install/vanilla-javascript\n' +
  '- https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md\n' +
  '- https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node\n' +
  '- https://tiptap.dev/docs/editor/api/commands/content/set-content\n' +
  '- https://vite.dev/guide/build.html#library-mode\n' +
  '- https://github.com/jsdom/jsdom\n\n' + allNotices + '\n';
writeFileSync(resolve(root, 'THIRD_PARTY_LICENSES.md'), evidence);
mkdirSync(resolve(root, 'generated'), { recursive: true });
writeFileSync(resolve(root, 'generated/runtime-licenses.txt'), `/*!\n${allNotices.replaceAll('*/', '* /')}\n*/`);
