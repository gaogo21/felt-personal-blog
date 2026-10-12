import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '../../src/Blog.Web/wwwroot/vendor/tabler');
await mkdir(output, { recursive: true });
const css = await readFile(resolve(root, 'node_modules/@tabler/core/dist/css/tabler.min.css'), 'utf8');
await writeFile(resolve(output, 'tabler.min.css'), css.replace(/\/\*# sourceMappingURL=.*?\*\//g, ''));
const notices = await Promise.all(['@tabler/core'].map(async name => {
  const pkg = JSON.parse(await readFile(resolve(root, `node_modules/${name}/package.json`), 'utf8'));
  const license = await readFile(resolve(root, 'third-party/tabler-LICENSE.txt'), 'utf8');
  return `${name} ${pkg.version}\n${license}`;
}));
notices.push(await readFile(resolve(root, 'third-party/bootstrap-LICENSE.txt'), 'utf8'));
await writeFile(resolve(output, 'LICENSE.txt'), notices.join('\n\n'));
console.log('Built local Tabler CSS and license notices.');
