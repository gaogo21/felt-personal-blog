import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import vm from 'node:vm';
import { completeSlots, fixedSlots, galleryPosition, mergeSite } from '../../../src/Blog.Web/wwwroot/js/admin/site-contract.js';

const browserErrors=[],virtualConsole=new VirtualConsole();
virtualConsole.on('jsdomError',error=>browserErrors.push(error.message));
const dom = new JSDOM('<section id="admin-content"></section><div id="admin-status" hidden><span></span><button></button></div>', { url: 'http://localhost/admin/gallery', virtualConsole });
for (const name of ['window','document','HTMLButtonElement','HTMLElement','HTMLDialogElement','location','AbortController']) globalThis[name] = dom.window[name];
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { galleryPage, featuredPage, introductionPage, chooseImage } = await import('../../../src/Blog.Web/wwwroot/js/admin/site.js');
const root = document.querySelector('#admin-content');
const media = Array.from({length:12}, (_,i) => ({id:'image-'+i,src:'/image-'+i+'.png',kind:'Image',state:'Ready',alt:'图片 '+i}));
const articles = Array.from({length:5}, (_,i) => ({entityId:'article-'+i,slug:'article-'+i,title:'已发布文章 '+i,category:'专栏 '+i}));
let site, writes, reject;
function reset(featuredIds = articles.slice(0,3).map(a=>a.entityId)) {
  media.splice(12);
  site={etag:'"site-1-7"',value:{homeAbout:'介绍',aboutTitle:'关于',aboutText:'正文',aboutNote:'补充',topics:['技术'],galleryIds:media.slice(0,10).map(m=>m.id),featuredIds}};
  writes=[];reject=null;
  globalThis.fetch=async (url, options={}) => {
    if (url.includes('/media?')) return Response.json({items:media,total:media.length});
    if (url.includes('/public/v1/articles?')) return Response.json({items:articles,total:articles.length});
    if (url.endsWith('/public/v1/home')) return Response.json({featured:articles.filter(article=>site.value.featuredIds.includes(article.entityId))});
    if (url.endsWith('/site') && options.method==='PUT') {
      writes.push({body:JSON.parse(options.body),etag:options.headers['If-Match']});
      if(reject)return Response.json(reject.body,{status:reject.status});
      site={etag:'"site-1-8"',value:writes.at(-1).body};return Response.json(site);
    }
    if (url.endsWith('/site')) return Response.json(site);
    throw new Error('Unexpected request '+url);
  };
}
async function settle() { for(let i=0;i<8;i++)await new Promise(setImmediate); }
async function until(check) {
  const deadline=Date.now()+5000;
  while(!check()){
    assert.ok(Date.now()<deadline,'Timed out waiting for the UI operation to complete');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
function submit(form) { form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})); }

test('fixed positions reject missing, duplicate and excess selections', () => {
  assert.equal(completeSlots(fixedSlots(['a','b'],3),3),false);
  assert.equal(completeSlots(['a','b','c'],3),true);
  assert.equal(completeSlots(['a','a','c'],3),false);
  assert.equal(completeSlots(['a','b','c','d'],3),false);
  assert.equal(galleryPosition(0),'第一排 · 第1张');
  assert.equal(galleryPosition(9),'第二排 · 第5张');
  assert.deepEqual(mergeSite({galleryIds:['a'],homeAbout:'old'},{homeAbout:'new'}),{galleryIds:['a'],homeAbout:'new'});
});
test('gallery removal keeps its position empty and prevents incomplete saves', async () => {
  reset();await galleryPage();
  assert.equal(root.querySelectorAll('.image-slot').length,10);
  assert.equal(root.querySelectorAll('[data-upload]').length,0);
  root.querySelector('[data-remove="2"]').click();
  assert.equal(root.querySelector('#gallery-save').disabled,true);
  assert.match(root.querySelectorAll('.image-slot')[2].textContent,/空位置/);
  assert.equal(root.querySelectorAll('.image-slot')[3].querySelector('img').getAttribute('src'),media[3].src);
  submit(root.querySelector('form'));await settle();assert.equal(writes.length,0);
  root.querySelector('[data-choose="2"]').click();await settle();
  assert.equal(document.querySelector('[data-image="image-1"]').disabled,true);
  document.querySelector('[data-image="image-10"]').click();await settle();
  assert.equal(root.querySelector('#gallery-save').disabled,false);
  submit(root.querySelector('form'));await settle();
  assert.equal(writes.length,1);
  assert.equal(writes[0].body.galleryIds[2],'image-10');
  assert.equal(writes[0].body.galleryIds[3],'image-3');
  assert.deepEqual(writes[0].body.featuredIds,articles.slice(0,3).map(a=>a.entityId));
  assert.equal(writes[0].etag,'"site-1-7"');
});
test('featured selection cannot add a fourth article and preserves selected order', async () => {
  reset();await featuredPage();
  assert.equal(root.querySelector('[data-add="article-3"]').disabled,true);
  root.querySelector('[data-remove="1"]').click();
  assert.equal(root.querySelector('#featured-save').disabled,true);
  root.querySelector('[data-add="article-3"]').click();
  root.querySelector('[data-move="1"][data-step="-1"]').click();
  submit(root.querySelector('form'));await settle();
  assert.deepEqual(writes[0].body.featuredIds,['article-3','article-0','article-2']);
  assert.deepEqual(writes[0].body.galleryIds,media.slice(0,10).map(m=>m.id));
});
test('introduction preview and save preserve newlines and literal HTML', async () => {
  reset();await introductionPage();
  const text='Hello world\n第二行\n\n<script>plain text</script>';
  const input=root.querySelector('textarea');input.value=text;input.dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(root.querySelector('#intro-preview-copy').textContent,text);
  assert.equal(root.querySelector('#intro-preview-copy script'),null);
  submit(root.querySelector('form'));await settle();
  assert.equal(writes[0].body.homeAbout,text);
  assert.equal(writes[0].body.aboutText,'正文');
});
test('conflict keeps unsaved input instead of overwriting another module', async () => {
  reset();await introductionPage();
  root.querySelector('textarea').value='保留我的输入';
  reject={status:412,body:{code:'PRECONDITION_FAILED'}};
  submit(root.querySelector('form'));await settle();
  assert.equal(root.querySelector('textarea').value,'保留我的输入');
  assert.equal(document.querySelector('#admin-status').dataset.kind,'error');
  assert.match(document.querySelector('#admin-status span').textContent,/其他窗口/);
});
test('initial configuration can complete gallery and featured together', async () => {
  reset([]);await galleryPage();
  assert.equal(root.querySelector('#gallery-save').disabled,true);
  for(let i=0;i<3;i++){
    const input=root.querySelector('[name="setupFeatured'+i+'"]');
    input.value=articles[i].entityId;input.dispatchEvent(new window.Event('change',{bubbles:true}));
  }
  assert.equal(root.querySelector('#gallery-save').disabled,false);
  submit(root.querySelector('form'));await settle();
  assert.equal(writes[0].body.featuredIds.length,3);
  assert.equal(writes[0].body.galleryIds.length,10);
});
test('legacy unavailable featured selections can be repaired together with gallery', async () => {
  reset(['article-0','article-1','unavailable-article']);await galleryPage();
  assert.equal(root.querySelector('#gallery-save').disabled,true);
  const input=root.querySelector('[name="setupFeatured2"]');
  assert.ok(input);
  input.value='article-2';input.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.equal(root.querySelector('#gallery-save').disabled,false);
  submit(root.querySelector('form'));await settle();
  assert.deepEqual(writes[0].body.featuredIds,['article-0','article-1','article-2']);
});
test('gallery upload only fills an empty slot and waits for ready before saving', async () => {
  reset();const request=globalThis.fetch;
  const fresh={id:'uploaded-image',src:'/uploaded.png',kind:'Image',state:'Ready',alt:'新图片'};
  let uploaded=false,scans=0;
  globalThis.fetch=async (url,options={})=>{
    if(url.endsWith('/media/uploads')){
      assert.equal(options.method,'POST');
      assert.equal(options.body.get('sha256').length,64);
      uploaded=true;return Response.json({id:fresh.id},{status:202});
    }
    if(url.endsWith('/media/'+fresh.id))return Response.json(scans++===0?{...fresh,state:'Processing'}:fresh);
    return request(url,options);
  };
  await galleryPage();
  assert.equal(root.querySelector('[data-upload="0"]'),null);
  root.querySelector('[data-remove="0"]').click();
  root.querySelector('[data-upload="0"]').click();
  const input=root.querySelector('#gallery-upload');
  Object.defineProperty(input,'files',{value:[new File(['image bytes'],'photo.png',{type:'image/png'})]});
  input.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.equal(root.querySelector('#gallery-save').disabled,true);
  await until(()=>uploaded && !root.querySelector('#gallery-save').disabled);
  assert.equal(uploaded,true);
  assert.equal(writes.length,0);
  assert.equal(root.querySelector('#gallery-save').disabled,false);
  assert.equal(root.querySelector('.image-slot img').getAttribute('src'),fresh.src);
});
test('image picker refresh discovers newly uploaded images without losing other slots', async () => {
  reset();
  const pool=[...media],fresh={...media[0],id:'new-image',alt:'新增图片'};
  globalThis.fetch=async ()=>Response.json({items:[...media,fresh],total:media.length+1});
  const selection=chooseImage(pool,['image-0']);
  document.querySelector('[data-refresh-images]').click();await settle();
  assert.equal(document.querySelector('[data-image="image-0"]').disabled,true);
  document.querySelector('[data-image="new-image"]').click();
  assert.equal((await selection).id,'new-image');
  assert.equal(pool.at(-1).id,'new-image');
});
test('public introduction animation preserves whitespace and uses text nodes', async () => {
  const source=await readFile(new URL('../../../dist/about-stage.js',import.meta.url),'utf8');
  const {mountAboutStage}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  globalThis.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
  globalThis.IntersectionObserver=class {observe(){}disconnect(){}};
  globalThis.cancelAnimationFrame=()=>{};
  root.innerHTML='<section class="about-stage"><p class="about-statement"></p></section>';
  const text='First  line\n第二行\n\n<script>literal</script>';
  root.querySelector('p').textContent=text;
  const dispose=mountAboutStage(root.firstElementChild);
  assert.equal(root.querySelector('p').textContent,text);
  assert.equal(root.querySelector('p script'),null);
  assert.equal(root.querySelector('p').getAttribute('aria-label'),text);
  dispose();
});
test('six public columns render six cards and eighteen images', async () => {
  const source=await readFile(new URL('../../../dist/app.js',import.meta.url),'utf8');
  const body=source.replace(/^import .*\n/u,'');
  const context={document:{querySelector:()=>null,querySelectorAll:()=>[]},matchMedia:()=>({matches:false})};
  vm.createContext(context);
  vm.runInContext(body.slice(0,body.indexOf('function setupExperience'))+';testViews={columnsStage,columnDirectory};',context);
  const columns=Array.from({length:6},(_,i)=>({id:'column-'+i,name:'专栏 '+i,intro:'介绍 '+i,count:0,order:i+1,articleIds:[],images:media.slice(0,3)}));
  vm.runInContext('columns='+JSON.stringify(columns),context);
  const html=JSDOM.fragment(context.testViews.columnsStage());
  assert.equal(html.querySelectorAll('.column-panel').length,6);
  assert.equal(html.querySelectorAll('.column-image').length,18);
  assert.equal(html.querySelectorAll('.column-number')[5].textContent,'06');
});
test('column directory keeps the visible number when stored positions have gaps', async () => {
  const {loadRoute}=await import('../../../dist/data.js');
  const columns=Array.from({length:6},(_,i)=>({slug:'column-'+i,name:'专栏 '+i,introduction:'说明',position:2+i*3,publishedArticleCount:0,images:media.slice(0,3)}));
  globalThis.fetch=async url=>Response.json(url.endsWith('/home')?{featured:[],gallery:[],homeAbout:'',columns}:{column:columns[5],articles:[]});
  const state=await loadRoute('column','column-5',1,new AbortController().signal);
  assert.deepEqual(state.columns.map(column=>column.order),[1,2,3,4,5,6]);
});
test('article save freezes the editor while pending and preserves input after failure', async () => {
  reset();
  const request=globalThis.fetch,documentJson={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'正文'}]}]};
  const article={id:'test-article',slug:'draft-note',state:'Draft',etag:'"article-1"',draft:{title:'原始标题',summary:'摘要',intro:'导读',columnId:'column-0',coverMediaId:null,contentJson:documentJson,etag:'"draft-1"'}};
  let resolveSave,payload,editable=true;
  globalThis.fetch=async (url,options={})=>{
    if(url.endsWith('/articles/test-article/draft')){
      payload=JSON.parse(options.body);
      return new Promise(resolve=>{resolveSave=resolve;});
    }
    if(url.endsWith('/articles/test-article/revisions'))return Response.json([]);
    if(url.endsWith('/articles/test-article'))return Response.json(article);
    if(url.endsWith('/columns'))return Response.json({items:[{id:'column-0',name:'专栏',state:'Active'}]});
    return request(url,options);
  };
  globalThis.__editorStub={createBodyEditor:()=>({getJSON:()=>documentJson,setEditable:value=>{editable=value;},destroy(){},setContent(){}})};
  const source=await readFile(new URL('../../../src/Blog.Web/wwwroot/js/admin/articles.js',import.meta.url),'utf8');
  const apiUrl=new URL('../../../src/Blog.Web/wwwroot/js/admin/api.js',import.meta.url).href;
  const fixture=source.replace('"./api.js"',JSON.stringify(apiUrl)).replace('import { createBodyEditor } from "./editor.bundle.js";','const {createBodyEditor}=globalThis.__editorStub;');
  const module=await import('data:text/javascript;base64,'+Buffer.from(fixture).toString('base64'));
  await module.editArticle(article.id);
  const form=root.querySelector('#article-edit'),input=form.elements.namedItem('title');
  input.value='我的修改';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  submit(form);
  assert.equal(editable,false);
  assert.equal(input.disabled,true);
  assert.equal(payload.title,'我的修改');
  resolveSave(Response.json({code:'VALIDATION_FAILED',fields:{title:['Invalid']}},{status:422}));
  await settle();
  assert.equal(editable,true);
  assert.equal(input.disabled,false);
  assert.equal(input.value,'我的修改');
  assert.equal(root.querySelector('#unsaved').textContent,'有未保存修改');
  module.dispose();
});
afterEach(()=>assert.deepEqual(browserErrors.splice(0),[],'Unexpected browser errors'));
after(()=>{dom.window.close();});
