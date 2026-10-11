import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const src=fs.readFileSync('dist/app.js','utf8'),css=fs.readFileSync('dist/style.css','utf8');
const context={document:{querySelector:()=>null,querySelectorAll:()=>[]},matchMedia:()=>({matches:false})};
vm.createContext(context);
vm.runInContext(src.replace(/^import .*\n/,'').slice(0,src.replace(/^import .*\n/,'').indexOf('function setupExperience'))+';exports={home,articleList,life,projectList,about,notfound};',context);
for(const[name,render]of Object.entries(context.exports)) {
 const html=render();assert(html.includes('<h1'),name+' requires a title');assert(!/undefined|NaN/.test(html),name+' has unresolved content');
 for(const m of html.matchAll(/(?:src|poster)="(\/assets\/[^\"]+)"/g))assert(fs.existsSync('dist'+m[1]),`missing ${m[1]}`);
}
for(const m of css.matchAll(/url\(['"]?(\/assets\/[^)'"\s]+)['"]?\)/g))assert(fs.existsSync('dist'+m[1]),`missing CSS asset ${m[1]}`);
assert(src.includes('await loadRoute'));assert(src.includes("import('/collectible.js')"));assert(css.includes('prefers-reduced-motion'));
assert(!src.includes('localStorage'));assert(!src.includes('body:`'));assert.equal((context.exports.home().match(/class="collectible-figure"/g)||[]).length,3);
const carousel=fs.readFileSync('dist/collectible.js','utf8');for(const text of ['INTERVAL=3000','visibilitychange','touchend','prefers-reduced-motion'])assert(carousel.includes(text));
const demo=JSON.parse(fs.readFileSync('data/demo-content.json','utf8'));
for(const media of demo.media)assert(fs.existsSync('dist'+media.designPath));
console.log('Frontend static assets, empty states, dynamic content loading and retained hero passed. Real API/browser flows are tested separately.');
