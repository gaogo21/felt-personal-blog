import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const source = readFileSync(resolve(root, 'src/Blog.Web/Domain/ContentLimits.cs'), 'utf8');
const target = resolve(root, 'frontend/editor/src/content-limits.json');
const keys = ['BodyScalars','LinkScalars','AltScalars','CaptionScalars','CreditScalars','LicenseScalars','JsonBytes','JsonNodes','JsonDepth','CodeScalars','TableRows','TableColumns','CellScalars'];
const constants = Object.fromEntries([...source.matchAll(/\b(\w+)\s*=\s*([0-9]+)/g)].map(m => [m[1], Number(m[2])]));
// The only calculated editor limit in the historical C# contract.
constants.JsonBytes = 2 * 1048576;
const output = JSON.stringify(Object.fromEntries(keys.map(k => { if (!Number.isInteger(constants[k])) throw new Error('Missing '+k); return [k, constants[k]]; })), null, 2)+'\n';
if (process.argv.includes('--check')) { if (readFileSync(target,'utf8') !== output) throw new Error('Editor limits differ from server; run npm run build.'); }
else writeFileSync(target, output);
