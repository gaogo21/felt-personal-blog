// Three approved illustrations, composited as a carousel. No live 3D or pose rig.
export async function mountCollectible(root){
  const figures=[...root.querySelectorAll('.collectible-figure')],dots=[...root.querySelectorAll('[data-select]')],stage=root.querySelector('.collectible-stage'),controls=root.querySelector('.collectible-controls'),toggle=root.querySelector('.look-toggle'),status=root.querySelector('.look-status'),count=root.querySelector('.look-count');
  const media=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover: hover) and (pointer: fine)');
  const INTERVAL=3000;let current=0,available=[],disposed=false,visible=true,userPaused=media.matches,hovered=false,focused=false,manualHeld=false,ready=false,raf=0,start=0,touch=null;
  let transitionRaf=0,activeAnimations=[];const listeners=[],times=[];const on=(target,event,fn,options)=>{target.addEventListener(event,fn,options);listeners.push(()=>target.removeEventListener(event,fn,options))};
  const setStatus=()=>{const reason=!ready?'loading':available.length<2?'static':userPaused?'paused':document.hidden?'hidden':!visible?'offscreen':hovered?'hover':focused?'focus':manualHeld?'manual':'playing';root.dataset.playback=reason;status.textContent=reason==='playing'?'THREE SIDES. ONE ME.':reason==='loading'?'LOADING PORTRAITS':reason==='static'?'STATIC PORTRAIT':reason==='paused'?'ROTATION PAUSED':'ROTATION ON HOLD';toggle.setAttribute('aria-pressed',String(userPaused));toggle.setAttribute('aria-label',userPaused?'Play automatic rotation':'Pause automatic rotation');toggle.querySelector('.toggle-label').textContent=userPaused?'PLAY':'PAUSE';toggle.querySelector('[aria-hidden]').textContent=userPaused?'>':'||';return reason;};
  const canPlay=()=>ready&&available.length>1&&!userPaused&&!hovered&&!focused&&!manualHeld&&!document.hidden&&visible;
  function render(){figures.forEach((figure,i)=>{if(!available.includes(i)){figure.hidden=true;return}figure.hidden=false;const offset=(available.indexOf(i)-available.indexOf(current)+available.length)%available.length;figure.dataset.slot=offset===0?'center':offset===1?'right':'left'});dots.forEach((dot,i)=>{dot.disabled=!available.includes(i);dot.setAttribute('aria-pressed',String(i===current))});root.dataset.current=figures[current]?.dataset.look||'none';root.dataset.currentIndex=String(current);root.dataset.available=String(available.length);count.textContent=String(available.indexOf(current)+1).padStart(2,'0')+' / '+String(available.length).padStart(2,'0');}
  const snapshot=figure=>{const style=getComputedStyle(figure);return{transform:style.transform,filter:style.filter}};
  function finishTransition(){cancelAnimationFrame(transitionRaf);transitionRaf=0;activeAnimations.forEach(animation=>animation.cancel());activeAnimations=[];figures.forEach(figure=>figure.style.removeProperty('z-index'));root.dataset.phase='settled'}
  function intermediate(from,to,amount,scaleFactor=1){const read=value=>(value.match(/matrix\(([^)]+)\)/)?.[1]||'1,0,0,1,0,0').split(',').map(Number);const a=read(from),b=read(to),m=a.map((v,i)=>v+(b[i]-v)*amount);m[0]*=scaleFactor;m[3]*=scaleFactor;return'matrix('+m.join(',')+')'}
  function animateDepth(origins,previous){if(media.matches||typeof figures[0]?.animate!=='function')return;const targets=figures.map(snapshot);const begin=performance.now();root.dataset.phase='retreat';
    figures.forEach((figure,i)=>{if(!available.includes(i))return;figure.style.zIndex=i===previous?'3':i===current?'2':'1';let keys;
      if(i===previous)keys=[{...origins[i],offset:0},{transform:intermediate(origins[i].transform,targets[i].transform,.2,.82),filter:'blur(3px) brightness(.8)',offset:.225},{...targets[i],offset:1}];
      else if(i===current)keys=[{...origins[i],offset:0},{...origins[i],offset:.225},{...targets[i],offset:1}];
      else keys=[{...origins[i],offset:0},{transform:intermediate(origins[i].transform,targets[i].transform,.5,.85),filter:'blur(8px) brightness(.5)',offset:.5},{...targets[i],offset:1}];
      activeAnimations.push(figure.animate(keys.map(key=>({...key,easing:'cubic-bezier(.4,0,.2,1)'})),{duration:800,easing:'linear',fill:'none'}));
    });
    const phase=now=>{if(disposed)return;const elapsed=now-begin;if(elapsed>=800){finishTransition();return}if(elapsed>=180)root.dataset.phase='advance';if(elapsed>=360){figures.forEach((figure,i)=>figure.style.zIndex=i===current?'3':i===previous?'2':'1');root.dataset.phase='arrive'}transitionRaf=requestAnimationFrame(phase)};transitionRaf=requestAnimationFrame(phase);
  }
  function change(index,source){if(!available.includes(index)||index===current)return;const origins=figures.map(snapshot),previous=current;finishTransition();current=index;render();animateDepth(origins,previous);root.dataset.lastChange=source;times.push({at:Math.round(performance.now()),look:root.dataset.current,source});root.dataset.changes=JSON.stringify(times.slice(-12));}
  function next(step,source){if(available.length<2)return;change(available[(available.indexOf(current)+step+available.length)%available.length],source)}
  function frame(now){raf=0;if(disposed||!canPlay()){setStatus();return}if(now-start>=INTERVAL){next(1,'auto');start=now}root.style.setProperty('--progress',String(Math.min((now-start)/INTERVAL,1)));raf=requestAnimationFrame(frame)}
  function sync(){cancelAnimationFrame(raf);raf=0;start=performance.now();root.style.setProperty('--progress','0');setStatus();if(canPlay())raf=requestAnimationFrame(frame)}
  function manual(index,step){if(!ready)return;manualHeld=true;if(index!==null)change(index,'manual');else next(step,'manual');sync()}
  figures.forEach(figure=>{on(figure,'pointerenter',e=>{if(e.pointerType==='mouse'&&fine.matches){hovered=true;sync()}});on(figure,'pointerleave',e=>{if(e.pointerType==='mouse'){hovered=false;manualHeld=false;sync()}})});
  dots.forEach((dot,i)=>on(dot,'click',()=>manual(i,0)));
  root.querySelectorAll('[data-step]').forEach(button=>on(button,'click',()=>manual(null,Number(button.dataset.step))));
  on(toggle,'click',()=>{userPaused=!userPaused;manualHeld=false;sync()});
  on(controls,'pointerleave',()=>{manualHeld=false;sync()});
  function updateFocus(){focused=[stage,controls].some(el=>el.contains(document.activeElement))&&!!document.activeElement?.matches(':focus-visible');if(!focused)manualHeld=false;sync()}
  on(root,'focusin',updateFocus);on(root,'focusout',()=>queueMicrotask(updateFocus));
  on(stage,'keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();manual(null,e.key==='ArrowLeft'?-1:1)}if(e.key==='Home'){e.preventDefault();manual(available[0],0)}});
  on(root,'pointermove',e=>{if(!fine.matches||e.pointerType!=='mouse'||media.matches||userPaused)return;const r=root.getBoundingClientRect();root.style.setProperty('--px',(((e.clientX-r.left)/r.width-.5)*10).toFixed(2)+'px');root.style.setProperty('--py',(((e.clientY-r.top)/r.height-.5)*6).toFixed(2)+'px')});
  on(root,'pointerleave',()=>{root.style.setProperty('--px','0px');root.style.setProperty('--py','0px');hovered=false;manualHeld=false;sync()});
  on(stage,'touchstart',e=>{touch=e.touches[0]?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null;manualHeld=true;sync()},{passive:true});
  on(stage,'touchend',e=>{if(touch&&e.changedTouches[0]){const dx=e.changedTouches[0].clientX-touch.x,dy=e.changedTouches[0].clientY-touch.y;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.2)next(dx<0?1:-1,'swipe')}touch=null;manualHeld=false;sync()},{passive:true});
  on(stage,'touchcancel',()=>{touch=null;manualHeld=false;sync()},{passive:true});
  on(document,'visibilitychange',()=>{hovered=false;if(document.hidden)finishTransition();sync()});
  on(window,'blur',()=>{hovered=false;root.style.setProperty('--px','0px');root.style.setProperty('--py','0px')});
  on(media,'change',()=>{if(media.matches){finishTransition();userPaused=true;root.style.setProperty('--px','0px');root.style.setProperty('--py','0px')}sync()});
  const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting&&entries[0].intersectionRatio>.15;if(!visible)finishTransition();sync()},{threshold:[0,.15]});observer.observe(root);
  const results=await Promise.all(figures.map(figure=>{const img=figure.querySelector('img');return new Promise(resolve=>{let ended=false;const end=ok=>{if(ended)return;ended=true;clearTimeout(timer);resolve(ok)};const timer=setTimeout(()=>end(false),12000);img.decode().then(()=>end(img.naturalWidth>0)).catch(()=>end(false))})}));
  if(disposed||!root.isConnected){observer.disconnect();listeners.forEach(fn=>fn());return()=>{}}
  available=results.map((ok,i)=>ok?i:-1).filter(i=>i>=0);ready=true;
  if(available.length){current=available[0];render();sync()}else{figures.forEach(f=>f.hidden=true);root.querySelector('.collectible-error').hidden=false;root.dataset.playback='error';status.textContent='PORTRAITS UNAVAILABLE'}
  if(available.length<2)root.querySelectorAll('button').forEach(b=>b.disabled=true);
  return()=>{disposed=true;cancelAnimationFrame(raf);finishTransition();observer.disconnect();listeners.forEach(fn=>fn())};
}
