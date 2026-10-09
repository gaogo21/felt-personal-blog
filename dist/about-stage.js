// The section stays in normal document flow. Only text colour and decoration move.
export function mountAboutStage(root){
 const paragraph=root.querySelector('.about-statement'),media=matchMedia('(prefers-reduced-motion: reduce)'),text=paragraph.textContent,words=text.split(/\s+/);let raf=0,visible=false,started=null,completed=false,progress=0,disposed=false;
 paragraph.setAttribute('aria-label',text);paragraph.replaceChildren();
 const spans=words.map((word,i)=>{const span=document.createElement('span');span.textContent=word;span.setAttribute('aria-hidden','true');paragraph.append(span);if(i<words.length-1)paragraph.append(document.createTextNode(' '));return span});
 const clamp=n=>Math.max(0,Math.min(1,n));
 function paint(p){progress=Math.max(progress,p);spans.forEach((span,i)=>{const local=clamp((progress-i/words.length)/.16);span.style.opacity=String(.35+.65*local)});root.dataset.aboutReveal=progress.toFixed(3)}
 function finish(){completed=true;paint(1.16);root.dataset.aboutReveal='complete';cancelAnimationFrame(raf);raf=0}
 function frame(now){raf=0;if(disposed||!visible||document.hidden||completed)return;if(started===null)started=now;const r=paragraph.getBoundingClientRect(),scrollProgress=clamp((innerHeight*.92-r.top)/(innerHeight*.46)),timeProgress=clamp((now-started)/2100);paint(Math.max(scrollProgress,timeProgress)*1.16);if(progress>=1.159){finish();return}raf=requestAnimationFrame(frame)}
 function sync(){root.dataset.active=String(visible&&!document.hidden&&!media.matches);cancelAnimationFrame(raf);raf=0;if(media.matches){finish();return}if(visible&&!document.hidden&&!completed)raf=requestAnimationFrame(frame)}
 const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting&&entries[0].intersectionRatio>=.25;sync()},{threshold:[0,.25]});observer.observe(paragraph);
 const onVisibility=()=>{if(document.hidden)started=null;sync()};document.addEventListener('visibilitychange',onVisibility);media.addEventListener('change',sync);paint(0);sync();
 return()=>{disposed=true;cancelAnimationFrame(raf);observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);media.removeEventListener('change',sync)};
}
