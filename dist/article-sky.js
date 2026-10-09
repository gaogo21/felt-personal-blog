// A local, finite pointer response. No page transforms or continuous idle loop.
export function mountArticleSky(root){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),fine=matchMedia('(hover: hover) and (pointer: fine)');
 let visible=false,disposed=false,raf=0,last=null,x=0,y=0,initialized=false;
 const interactive=()=>fine.matches&&!reduced.matches;
 function stop(){cancelAnimationFrame(raf);raf=0;root.dataset.pointerActive='false';root.dataset.revealFrame='idle'}
 function position(){if(!last)return null;const r=root.getBoundingClientRect();const px=last.x-r.left,py=last.y-r.top;return px>=0&&py>=0&&px<=r.width&&py<=r.height?{x:px,y:py}:null}
 function paint(){raf=0;if(disposed||!visible||document.hidden||!interactive()){stop();return}const p=position();if(!p){stop();return}if(!initialized){x=p.x;y=p.y;initialized=true}else{x+=(p.x-x)*.28;y+=(p.y-y)*.28}root.style.setProperty('--reveal-x',x.toFixed(2)+'px');root.style.setProperty('--reveal-y',y.toFixed(2)+'px');root.dataset.pointerActive='true';if(Math.abs(p.x-x)+Math.abs(p.y-y)>.12){root.dataset.revealFrame='moving';raf=requestAnimationFrame(paint)}else{root.style.setProperty('--reveal-x',p.x.toFixed(2)+'px');root.style.setProperty('--reveal-y',p.y.toFixed(2)+'px');root.dataset.revealFrame='idle'}}
 function request(){if(!raf&&!disposed&&visible&&!document.hidden&&interactive())raf=requestAnimationFrame(paint)}
 function pointer(e){if(e.pointerType==='touch'||!interactive())return;last={x:e.clientX,y:e.clientY};request()}
 function leave(){last=null;initialized=false;stop()}
 function sync(){root.dataset.revealMode=interactive()?'interactive':'static';if(!interactive()||document.hidden){leave();return}request()}
 const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(!visible)leave();else request()});observer.observe(root);
 root.addEventListener('pointerenter',pointer,{passive:true});root.addEventListener('pointermove',pointer,{passive:true});root.addEventListener('pointerleave',leave,{passive:true});
 window.addEventListener('scroll',request,{passive:true});window.addEventListener('resize',request,{passive:true});document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync);fine.addEventListener('change',sync);sync();
 return()=>{disposed=true;stop();observer.disconnect();root.removeEventListener('pointerenter',pointer);root.removeEventListener('pointermove',pointer);root.removeEventListener('pointerleave',leave);window.removeEventListener('scroll',request);window.removeEventListener('resize',request);document.removeEventListener('visibilitychange',sync);reduced.removeEventListener('change',sync);fine.removeEventListener('change',sync)};
}
