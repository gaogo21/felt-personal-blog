// Natural-height sticky panels. Scroll only updates the preceding panel's scale.
export function mountColumns(root){
 const panels=[...root.querySelectorAll('.column-panel')],anchors=[...root.querySelectorAll('.column-anchor')],media=matchMedia('(min-width: 801px) and (min-height: 651px) and (prefers-reduced-motion: no-preference)');
 let raf=0,visible=false,disposed=false;
 function paint(){raf=0;if(disposed)return;panels.forEach((p,i)=>{const next=panels[i+1];let scale=1;if(media.matches&&next){const top=30+(i+1)*14,n=next.getBoundingClientRect().top,progress=Math.max(0,Math.min(1,(innerHeight-n)/(innerHeight-top)));scale=1-.03*progress}p.style.setProperty('--stack-scale',scale.toFixed(4))});root.dataset.stackMode=media.matches?'stacked':'flow'}
 function schedule(){if(!raf&&visible&&!document.hidden)raf=requestAnimationFrame(paint)}
 function mode(){cancelAnimationFrame(raf);raf=0;paint()}
 function focus(e){if(!media.matches||!e.target.matches(':focus-visible'))return;const panel=e.target.closest('.column-panel'),i=panels.indexOf(panel);if(i<0)return;const r=panel.getBoundingClientRect(),next=panels[i+1]?.getBoundingClientRect();if(r.top<0||(next&&next.top<r.top+r.height*.65)){const y=anchors[i].getBoundingClientRect().top+scrollY-(30+i*14);window.scrollTo({top:y,behavior:'instant'});schedule()}}
 const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)schedule();else{cancelAnimationFrame(raf);raf=0}});observer.observe(root);
 window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule,{passive:true});document.addEventListener('visibilitychange',schedule);media.addEventListener('change',mode);root.addEventListener('focusin',focus);paint();
 return()=>{disposed=true;cancelAnimationFrame(raf);observer.disconnect();window.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);document.removeEventListener('visibilitychange',schedule);media.removeEventListener('change',mode);root.removeEventListener('focusin',focus)};
}
