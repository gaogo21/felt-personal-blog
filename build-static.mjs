import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('dist/app.js','utf8');
const context={document:{querySelector:()=>null,querySelectorAll:()=>[]},matchMedia:()=>({matches:false})};
vm.createContext(context);
vm.runInContext(src.slice(0,src.indexOf('function setupExperience'))+';result=home();',context);
const page=fs.readFileSync('dist/index.html','utf8');
fs.writeFileSync('dist/index.html',page.replace(/(<main id="main" tabindex="-1">)[\s\S]*?(<\/main>)/,'$1'+context.result+'$2'));
console.log('Static homepage synchronized with frontend route.');
