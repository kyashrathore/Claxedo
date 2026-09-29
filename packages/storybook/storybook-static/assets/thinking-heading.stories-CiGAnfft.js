import{Z as Gt,i as e,b as K,x as yt,K as g,t as X,n as Wt,aa as ka,ab as a,a as wa,z as Sa,o as $a,L as O,a9 as Ta,ad as kt}from"./iframe-D288tw9h.js";import{T as Lt}from"./text-shimmer-SJimTaBu.js";import{T as Ca}from"./text-reveal-DqAQuMuw.js";import"./preload-helper-D9Z9MdNV.js";var _a=X("<span><span data-slot=track><span data-slot=entering></span><span data-slot=leaving>"),za=X(`<div style=display:grid;gap:24px;padding:20px;max-width:820px><style>
/* ── shared base ────────────────────────────────────────────────── */
[data-variant] {
  display: inline-flex;
  align-items: center;
}

[data-variant] [data-slot="track"] {
  display: grid;
  overflow: visible;
  min-height: 20px;
  justify-items: start;
  align-items: center;
  transition: width var(--h-duration, 600ms) var(--h-spring-soft, cubic-bezier(0.34, 1.1, 0.64, 1));
}

[data-variant] [data-slot="entering"],
[data-variant] [data-slot="leaving"] {
  grid-area: 1 / 1;
  line-height: 20px;
  white-space: nowrap;
  justify-self: start;
}

/* kill transitions before fonts are ready */
[data-variant][data-ready="false"] [data-slot="track"],
[data-variant][data-ready="false"] [data-slot="entering"],
[data-variant][data-ready="false"] [data-slot="leaving"] {
  transition-duration: 0ms !important;
}


/* ── 1. spring-up ───────────────────────────────────────────────── *
 * New text rises from below, old text exits upward.               */

[data-variant="spring-up"] [data-slot="entering"],
[data-variant="spring-up"] [data-slot="leaving"] {
  transition-property: transform, opacity, filter;
  transition-duration:
    var(--h-duration, 600ms),
    calc(var(--h-duration-raw, 600) * 0.6 * 1ms),
    calc(var(--h-duration-raw, 600) * 0.5 * 1ms);
  transition-timing-function: var(--h-spring), ease-out, ease-out;
}
[data-variant="spring-up"] [data-slot="entering"] {
  transform: translateY(0);
  opacity: 1;
  filter: blur(0);
}
[data-variant="spring-up"] [data-slot="leaving"] {
  transform: translateY(calc(var(--h-travel, 18px) * -1));
  opacity: 0;
  filter: blur(var(--h-blur, 0px));
}
[data-variant="spring-up"][data-swapping="true"] [data-slot="entering"] {
  transform: translateY(var(--h-travel, 18px));
  opacity: 0;
  filter: blur(var(--h-blur, 0px));
  transition-duration: 0ms !important;
}
[data-variant="spring-up"][data-swapping="true"] [data-slot="leaving"] {
  transform: translateY(0);
  opacity: 1;
  filter: blur(0);
  transition-duration: 0ms !important;
}


/* ── 2. spring-down ─────────────────────────────────────────────── *
 * New text drops from above, old text exits downward.             */

[data-variant="spring-down"] [data-slot="entering"],
[data-variant="spring-down"] [data-slot="leaving"] {
  transition-property: transform, opacity, filter;
  transition-duration:
    var(--h-duration, 600ms),
    calc(var(--h-duration-raw, 600) * 0.6 * 1ms),
    calc(var(--h-duration-raw, 600) * 0.5 * 1ms);
  transition-timing-function: var(--h-spring), ease-out, ease-out;
}
[data-variant="spring-down"] [data-slot="entering"] {
  transform: translateY(0);
  opacity: 1;
  filter: blur(0);
}
[data-variant="spring-down"] [data-slot="leaving"] {
  transform: translateY(var(--h-travel, 18px));
  opacity: 0;
  filter: blur(var(--h-blur, 0px));
}
[data-variant="spring-down"][data-swapping="true"] [data-slot="entering"] {
  transform: translateY(calc(var(--h-travel, 18px) * -1));
  opacity: 0;
  filter: blur(var(--h-blur, 0px));
  transition-duration: 0ms !important;
}
[data-variant="spring-down"][data-swapping="true"] [data-slot="leaving"] {
  transform: translateY(0);
  opacity: 1;
  filter: blur(0);
  transition-duration: 0ms !important;
}


/* ── 3. spring-pop ──────────────────────────────────────────────── *
 * Scale + slight vertical shift + blur. Playful, bouncy.          */

[data-variant="spring-pop"] [data-slot="entering"],
[data-variant="spring-pop"] [data-slot="leaving"] {
  transition-property: transform, opacity, filter;
  transition-duration:
    var(--h-duration, 600ms),
    calc(var(--h-duration-raw, 600) * 0.55 * 1ms),
    calc(var(--h-duration-raw, 600) * 0.55 * 1ms);
  transition-timing-function: var(--h-spring), ease-out, ease-out;
  transform-origin: left center;
}
[data-variant="spring-pop"] [data-slot="entering"] {
  transform: translateY(0) scale(1);
  opacity: 1;
  filter: blur(0);
}
[data-variant="spring-pop"] [data-slot="leaving"] {
  transform: translateY(calc(var(--h-travel, 18px) * -0.35)) scale(0.92);
  opacity: 0;
  filter: blur(var(--h-blur, 3px));
}
[data-variant="spring-pop"][data-swapping="true"] [data-slot="entering"] {
  transform: translateY(calc(var(--h-travel, 18px) * 0.35)) scale(0.92);
  opacity: 0;
  filter: blur(var(--h-blur, 3px));
  transition-duration: 0ms !important;
}
[data-variant="spring-pop"][data-swapping="true"] [data-slot="leaving"] {
  transform: translateY(0) scale(1);
  opacity: 1;
  filter: blur(0);
  transition-duration: 0ms !important;
}


/* ── 4. spring-blur ─────────────────────────────────────────────── *
 * Pure crossfade with heavy blur. No vertical movement.           *
 * Width still animates with spring.                               */

[data-variant="spring-blur"] [data-slot="entering"],
[data-variant="spring-blur"] [data-slot="leaving"] {
  transition-property: opacity, filter;
  transition-duration:
    calc(var(--h-duration-raw, 600) * 0.75 * 1ms),
    var(--h-duration, 600ms);
  transition-timing-function: ease-out, var(--h-spring-soft);
}
[data-variant="spring-blur"] [data-slot="entering"] {
  opacity: 1;
  filter: blur(0);
}
[data-variant="spring-blur"] [data-slot="leaving"] {
  opacity: 0;
  filter: blur(calc(var(--h-blur, 4px) * 2));
}
[data-variant="spring-blur"][data-swapping="true"] [data-slot="entering"] {
  opacity: 0;
  filter: blur(calc(var(--h-blur, 4px) * 2));
  transition-duration: 0ms !important;
}
[data-variant="spring-blur"][data-swapping="true"] [data-slot="leaving"] {
  opacity: 1;
  filter: blur(0);
  transition-duration: 0ms !important;
}


/* ── 5. odometer ──────────────────────────────────────────────── *
 * Both texts scroll vertically through a clipped track.           *
 *                                                                 *
 * overflow:hidden clips at the padding-box edge.                  *
 * mask-image fades to transparent at that same edge.              *
 * Result: content is invisible at the clip boundary → no hard     *
 * edge ever visible. Padding + mask height extend the clip area   *
 * so text has room to travel through the gradient fade zone.       *
 *                                                                 *
 * Uses transparent→white which works in both alpha &amp; luminance    *
 * mask modes (transparent=hidden, white=visible in both).         */

[data-variant="odometer"] [data-slot="track"] {
  --h-mask-stop: min(var(--h-mask-size, 20px), calc(50% - 0.5px));
  --h-odo-shift: calc(
    100% + var(--h-travel, 18px) + var(--h-mask-height, 0px) + max(calc(var(--h-mask-pad, 28px) - 28px), 0px)
  );
  position: relative;
  align-items: stretch;
  overflow: hidden;
  padding-block: calc(var(--h-mask-pad, 28px) + var(--h-mask-height, 0px));
  margin-block: calc((var(--h-mask-pad, 28px) + var(--h-mask-height, 0px)) * -1);
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0px,
    white var(--h-mask-stop),
    white calc(100% - var(--h-mask-stop)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0px,
    white var(--h-mask-stop),
    white calc(100% - var(--h-mask-stop)),
    transparent 100%
  );
  transition: width var(--h-duration, 600ms) var(--h-spring-soft, cubic-bezier(0.34, 1.1, 0.64, 1));
}

/* on swap, jump width instantly to the max of both texts */
[data-variant="odometer"][data-swapping="true"] [data-slot="track"] {
  transition-duration: 0ms !important;
}

[data-variant="odometer"] [data-slot="entering"],
[data-variant="odometer"] [data-slot="leaving"] {
  transition-property: transform;
  transition-duration: var(--h-duration, 600ms);
  transition-timing-function: var(--h-spring);
  opacity: 1;
}
/* settled: entering in view, leaving pushed below */
[data-variant="odometer"] [data-slot="entering"] {
  transform: translateY(0);
}
[data-variant="odometer"] [data-slot="leaving"] {
  transform: translateY(var(--h-odo-shift));
}
/* swapping: snap entering above, leaving in-place */
[data-variant="odometer"][data-swapping="true"] [data-slot="entering"] {
  transform: translateY(calc(var(--h-odo-shift) * -1));
  transition-duration: 0ms !important;
}
[data-variant="odometer"][data-swapping="true"] [data-slot="leaving"] {
  transform: translateY(0);
  transition-duration: 0ms !important;
}

/* ── odometer + blur ──────────────────────────────────────────── *
 * Optional: adds opacity + blur transitions on top of the         *
 * positional odometer movement.                                   */

[data-variant="odometer"][data-odo-blur="true"] [data-slot="entering"],
[data-variant="odometer"][data-odo-blur="true"] [data-slot="leaving"] {
  transition-property: transform, opacity, filter;
  transition-duration:
    var(--h-duration, 600ms),
    calc(var(--h-duration-raw, 600) * 0.6 * 1ms),
    calc(var(--h-duration-raw, 600) * 0.5 * 1ms);
}
[data-variant="odometer"][data-odo-blur="true"] [data-slot="entering"] {
  opacity: 1;
  filter: blur(0);
}
[data-variant="odometer"][data-odo-blur="true"] [data-slot="leaving"] {
  opacity: 0;
  filter: blur(var(--h-blur, 4px));
}
[data-variant="odometer"][data-odo-blur="true"][data-swapping="true"] [data-slot="entering"] {
  opacity: 0;
  filter: blur(var(--h-blur, 4px));
}
[data-variant="odometer"][data-odo-blur="true"][data-swapping="true"] [data-slot="leaving"] {
  opacity: 1;
  filter: blur(0);
}

/* ── debug: show fade zones ───────────────────────────────────── */
[data-variant="odometer"][data-debug="true"] [data-slot="track"] {
  outline: 1px dashed rgba(255, 0, 0, 0.6);
}
[data-variant="odometer"][data-debug="true"] [data-slot="track"]::before,
[data-variant="odometer"][data-debug="true"] [data-slot="track"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: var(--h-mask-stop);
  pointer-events: none;
}
[data-variant="odometer"][data-debug="true"] [data-slot="track"]::before {
  top: 0;
  background: linear-gradient(to bottom, rgba(255, 0, 0, 0.3), transparent);
}
[data-variant="odometer"][data-debug="true"] [data-slot="track"]::after {
  bottom: 0;
  background: linear-gradient(to top, rgba(255, 0, 0, 0.3), transparent);
}


/* ── slider styling ─────────────────────────────────────────────── */
input[type="range"].heading-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 140px;
  height: 4px;
  border-radius: 2px;
  background: var(--color-divider, #444);
  outline: none;
}
input[type="range"].heading-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-accent, #58f);
  cursor: pointer;
  border: none;
}
</style><div style=display:grid;grid-template-columns:1fr;gap:16px><div><span>TextReveal (production)</span><span><span></span></span></div></div><div style="border-top:1px solid var(--color-divider, #333);padding-top:16px;display:grid;gap:10px"><div style=display:flex;align-items:center;gap:12px><span>duration</span><input type=range class=heading-slider min=200 max=1400 step=50><span>ms</span></div><div style=display:flex;align-items:center;gap:12px><span>blur</span><input type=range class=heading-slider min=0 max=16 step=0.5><span>px</span></div><div style=display:flex;align-items:center;gap:12px><span>travel</span><input type=range class=heading-slider min=4 max=120 step=1><span>px</span></div><div style=display:flex;align-items:center;gap:12px><span>bounce</span><input type=range class=heading-slider min=1 max=2.2 step=0.05><span> </span></div><div style=display:flex;align-items:center;gap:12px><span>mask</span><input type=range class=heading-slider min=0 max=50 step=1><span>px </span></div><div style=display:flex;align-items:center;gap:12px><span>mask pad</span><input type=range class=heading-slider min=0 max=60 step=1><span>px</span></div><div style=display:flex;align-items:center;gap:12px><span>mask height</span><input type=range class=heading-slider min=0 max=80 step=1><span>px</span></div></div><div style=display:grid;gap:12px><div style=display:flex;gap:8px;flex-wrap:wrap><button></button><button>Prev</button><button>Next</button><button>Clear</button><button></button><button></button><button></button></div><div style=display:flex;gap:6px;flex-wrap:wrap></div><div style="font-size:11px;color:var(--color-text-weak, #888);font-family:monospace">heading: <!> · sim: <!> · bounce: <!> · odo-blur: `),Ia=X("<div><span></span><span><span>"),Ha=X("<button>");const Ea={title:"UI/ThinkingHeading",id:"components-thinking-heading",tags:["autodocs"],parameters:{docs:{description:{component:`### Overview
Playground for animating the secondary heading beside "Thinking".

Uses TextReveal for the production heading animation with tunable
duration, travel, bounce, and fade controls.`}}}},$=["Planning key generation details","Analyzing error handling",void 0,"Reviewing authentication flow","Considering edge cases","Evaluating performance","Structuring the response","Checking type safety","Designing the API surface","Mapping dependencies","Outlining test strategy"];function Na(i){const[n,o]=Gt({current:i.text,leaving:void 0,width:"auto",ready:!1,swapping:!1}),_=()=>n.current,z=()=>n.leaving,h=()=>n.width,y=()=>n.ready,P=()=>n.swapping;let k,d,b,c;const I=()=>k?.scrollWidth??0,B=()=>d?.scrollWidth??0,H=r=>{if(r<=0)return;const v=Number.parseFloat(h());Number.isFinite(v)&&r<=v||o("width",`${r}px`)},p=()=>{if(!_()){o("width","0px");return}const r=I();r>0&&o("width",`${r}px`)};return wa(Sa(()=>i.text,(r,v)=>{r!==v&&(o("swapping",!0),o("leaving",v),o("current",r),c&&cancelAnimationFrame(c),c=requestAnimationFrame(()=>{if(i.variant==="odometer"){const x=I(),w=B();H(Math.max(x,w)),b?.offsetHeight,o("swapping",!1)}else b?.offsetHeight,o("swapping",!1),p();c=void 0}))})),$a(()=>{p(),document.fonts?.ready.finally(()=>{p(),requestAnimationFrame(()=>o("ready",!0))})}),Wt(()=>{c&&cancelAnimationFrame(c)}),(()=>{var r=_a(),v=r.firstChild,x=v.firstChild,w=x.nextSibling,V=b;typeof V=="function"?kt(V,r):b=r;var l=k;typeof l=="function"?kt(l,x):k=x,e(x,()=>_()??" ");var F=d;return typeof F=="function"?kt(F,w):d=w,e(w,()=>z()??" "),g(s=>{var Y=i.variant,R=y(),N=P(),A=i.debug?"true":void 0,E=i.odoBlur?"true":void 0,M=h();return Y!==s.e&&O(r,"data-variant",s.e=Y),R!==s.t&&O(r,"data-ready",s.t=R),N!==s.a&&O(r,"data-swapping",s.a=N),A!==s.o&&O(r,"data-debug",s.o=A),E!==s.i&&O(r,"data-odo-blur",s.i=E),M!==s.n&&Ta(v,"width",s.n=M),s},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0}),r})()}const Z=i=>({padding:"6px 14px","border-radius":"6px",border:"1px solid var(--color-divider, #333)",background:i?"var(--color-danger-fill, #c33)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"13px"}),J=i=>({padding:"4px 12px","border-radius":"6px",border:i?"1px solid var(--color-accent, #58f)":"1px solid var(--color-divider, #333)",background:i?"var(--color-accent, #58f)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"12px"}),T={"font-size":"11px","font-family":"monospace",color:"var(--color-text-weak, #666)","min-width":"70px","flex-shrink":"0","text-align":"right"},C={"font-family":"monospace","font-size":"11px",color:"var(--color-text-weak, #aaa)","min-width":"60px"},Dt={"font-size":"11px","font-family":"monospace",color:"var(--color-text-weak, #666)"},Ot={display:"flex","align-items":"center",gap:"8px","min-width":"0","font-size":"14px","font-weight":"500","line-height":"20px","min-height":"20px",color:"var(--text-weak, #aaa)"},Vt={"min-width":"0",overflow:"visible","white-space":"nowrap",color:"var(--text-weaker, #888)","font-weight":"400"},Ft={padding:"16px 20px","border-radius":"10px",border:"1px solid var(--color-divider, #333)",background:"var(--h-mask-bg, #1a1a1a)",display:"grid",gap:"8px"},Aa=[],Q={render:()=>{const[i,n]=Gt({heading:$[0],headingIndex:0,active:!0,cycling:!1,duration:550,blur:2,travel:4,bounce:1.35,maskSize:12,maskPad:9,maskHeight:0,debug:!1,odoBlur:!1}),o=()=>i.heading,_=()=>i.headingIndex,z=()=>i.active,h=()=>i.cycling,y=()=>i.duration,P=()=>i.blur,k=()=>i.travel,d=()=>i.bounce,b=()=>i.maskSize,c=()=>i.maskPad,I=()=>i.maskHeight,B=()=>i.debug,H=()=>i.odoBlur;let p;const r=()=>{const l=(_()+1)%$.length;n("headingIndex",l),n("heading",$[l])},v=()=>{const l=(_()-1+$.length)%$.length;n("headingIndex",l),n("heading",$[l])},x=()=>{if(h()){clearTimeout(p),p=void 0,n("cycling",!1);return}n("cycling",!0);const l=()=>{h()&&(r(),p=setTimeout(l,850+Math.floor(Math.random()*550)))};p=setTimeout(l,850+Math.floor(Math.random()*550))},w=()=>{n("heading",void 0),h()&&(clearTimeout(p),p=void 0,n("cycling",!1))};Wt(()=>{p&&clearTimeout(p)});const V=()=>({"--h-duration":`${y()}ms`,"--h-duration-raw":`${y()}`,"--h-blur":`${P()}px`,"--h-travel":`${k()}px`,"--h-spring":`cubic-bezier(0.34, ${d()}, 0.64, 1)`,"--h-spring-soft":`cubic-bezier(0.34, ${Math.max(d()*.7,1)}, 0.64, 1)`,"--h-mask-size":`${b()}px`,"--h-mask-pad":`${c()}px`,"--h-mask-height":`${I()}px`,"--h-mask-bg":"#1a1a1a"});return(()=>{var l=za(),F=l.firstChild,s=F.nextSibling,Y=s.firstChild,R=Y.firstChild,N=R.nextSibling,A=N.firstChild,E=s.nextSibling,M=E.firstChild,wt=M.firstChild,tt=wt.nextSibling,at=tt.nextSibling,jt=at.firstChild,St=M.nextSibling,$t=St.firstChild,et=$t.nextSibling,nt=et.nextSibling,Ut=nt.firstChild,Tt=St.nextSibling,Ct=Tt.firstChild,it=Ct.nextSibling,rt=it.nextSibling,qt=rt.firstChild,_t=Tt.nextSibling,zt=_t.firstChild,st=zt.nextSibling,G=st.nextSibling,Kt=G.firstChild,It=_t.nextSibling,Ht=It.firstChild,lt=Ht.nextSibling,W=lt.nextSibling,Zt=W.firstChild,Nt=It.nextSibling,At=Nt.firstChild,ot=At.nextSibling,dt=ot.nextSibling,Jt=dt.firstChild,Qt=Nt.nextSibling,Pt=Qt.firstChild,pt=Pt.nextSibling,ut=pt.nextSibling,Xt=ut.firstChild,ta=E.nextSibling,Bt=ta.firstChild,j=Bt.firstChild,gt=j.nextSibling,ct=gt.nextSibling,vt=ct.nextSibling,U=vt.nextSibling,q=U.nextSibling,mt=q.nextSibling,Yt=Bt.nextSibling,L=Yt.nextSibling,aa=L.firstChild,Rt=aa.nextSibling,ea=Rt.nextSibling,Et=ea.nextSibling,na=Et.nextSibling,Mt=na.nextSibling;return Mt.nextSibling,e(N,K(Lt,{text:"Thinking",get active(){return z()}}),A),e(A,K(Ca,{get text(){return o()},get duration(){return y()},travel:25,edge:17,get spring(){return`cubic-bezier(0.34, ${d()}, 0.64, 1)`},get springSoft(){return`cubic-bezier(0.34, ${Math.max(d()*.7,1)}, 0.64, 1)`},growOnly:!0})),e(s,()=>Aa.map(t=>(()=>{var f=Ia(),m=f.firstChild,S=m.nextSibling,D=S.firstChild;return e(m,()=>t.label),e(S,K(Lt,{text:"Thinking",get active(){return z()}}),D),e(D,K(Na,{get text(){return o()},get variant(){return t.key},get debug(){return yt(()=>t.key==="odometer")()&&B()},get odoBlur(){return yt(()=>t.key==="odometer")()&&H()}})),g(u=>{var ht=Ft,bt=Dt,xt=Ot,ft=Vt;return u.e=a(f,ht,u.e),u.t=a(m,bt,u.t),u.a=a(S,xt,u.a),u.o=a(D,ft,u.o),u},{e:void 0,t:void 0,a:void 0,o:void 0}),f})()),null),tt.$$input=t=>n("duration",Number(t.currentTarget.value)),e(at,y,jt),et.$$input=t=>n("blur",Number(t.currentTarget.value)),e(nt,P,Ut),it.$$input=t=>n("travel",Number(t.currentTarget.value)),e(rt,k,qt),st.$$input=t=>n("bounce",Number(t.currentTarget.value)),e(G,()=>d().toFixed(2),Kt),e(G,(()=>{var t=yt(()=>d()<=1.05);return()=>t()?"(none)":d()>=1.9?"(heavy)":""})(),null),lt.$$input=t=>n("maskSize",Number(t.currentTarget.value)),e(W,b,Zt),e(W,()=>b()===0?"(hard)":"",null),ot.$$input=t=>n("maskPad",Number(t.currentTarget.value)),e(dt,c,Jt),pt.$$input=t=>n("maskHeight",Number(t.currentTarget.value)),e(ut,I,Xt),j.$$click=x,e(j,()=>h()?"Stop sim":"Simulate jitter"),gt.$$click=v,ct.$$click=r,vt.$$click=w,U.$$click=()=>n("active",t=>!t),e(U,()=>z()?"Shimmer: on":"Shimmer: off"),q.$$click=()=>n("debug",t=>!t),e(q,()=>B()?"Debug mask: on":"Debug mask"),mt.$$click=()=>n("odoBlur",t=>!t),e(mt,()=>H()?"Odo blur: on":"Odo blur"),e(Yt,()=>$.map((t,f)=>(()=>{var m=Ha();return m.$$click=()=>{n("headingIndex",f),n("heading",t)},e(m,t??"(no submessage)"),g(S=>a(m,J(_()===f),S)),m})())),e(L,()=>o()??"(none)",Rt),e(L,()=>h()?"on":"off",Et),e(L,()=>d().toFixed(2),Mt),e(L,()=>H()?"on":"off",null),g(t=>{var f={...V()},m=Ft,S=Dt,D=Ot,u=Vt,ht=T,bt=C,xt=T,ft=C,ia=T,ra=C,sa=T,la=C,oa=T,da=C,pa=T,ua=C,ga=T,ca=C,va=Z(h()),ma=Z(),ha=Z(),ba=Z(),xa=J(z()),fa=J(B()),ya=J(H());return t.e=a(l,f,t.e),t.t=a(Y,m,t.t),t.a=a(R,S,t.a),t.o=a(N,D,t.o),t.i=a(A,u,t.i),t.n=a(wt,ht,t.n),t.s=a(at,bt,t.s),t.h=a($t,xt,t.h),t.r=a(nt,ft,t.r),t.d=a(Ct,ia,t.d),t.l=a(rt,ra,t.l),t.u=a(zt,sa,t.u),t.c=a(G,la,t.c),t.w=a(Ht,oa,t.w),t.m=a(W,da,t.m),t.f=a(At,pa,t.f),t.y=a(dt,ua,t.y),t.g=a(Pt,ga,t.g),t.p=a(ut,ca,t.p),t.b=a(j,va,t.b),t.T=a(gt,ma,t.T),t.A=a(ct,ha,t.A),t.O=a(vt,ba,t.O),t.I=a(U,xa,t.I),t.S=a(q,fa,t.S),t.W=a(mt,ya,t.W),t},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0,r:void 0,d:void 0,l:void 0,u:void 0,c:void 0,w:void 0,m:void 0,f:void 0,y:void 0,g:void 0,p:void 0,b:void 0,T:void 0,A:void 0,O:void 0,I:void 0,S:void 0,W:void 0}),g(()=>tt.value=y()),g(()=>et.value=P()),g(()=>it.value=k()),g(()=>st.value=d()),g(()=>lt.value=b()),g(()=>ot.value=c()),g(()=>pt.value=I()),l})()}};Q.parameters={...Q.parameters,docs:{...Q.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [state, setState] = createStore({
      heading: HEADINGS[0],
      headingIndex: 0,
      active: true,
      cycling: false,
      duration: 550,
      blur: 2,
      travel: 4,
      bounce: 1.35,
      maskSize: 12,
      maskPad: 9,
      maskHeight: 0,
      debug: false,
      odoBlur: false
    });
    const heading = () => state.heading;
    const headingIndex = () => state.headingIndex;
    const active = () => state.active;
    const cycling = () => state.cycling;
    const duration = () => state.duration;
    const blur = () => state.blur;
    const travel = () => state.travel;
    const bounce = () => state.bounce;
    const maskSize = () => state.maskSize;
    const maskPad = () => state.maskPad;
    const maskHeight = () => state.maskHeight;
    const debug = () => state.debug;
    const odoBlur = () => state.odoBlur;
    let cycleTimer;
    const nextHeading = () => {
      const next = (headingIndex() + 1) % HEADINGS.length;
      setState("headingIndex", next);
      setState("heading", HEADINGS[next]);
    };
    const prevHeading = () => {
      const prev = (headingIndex() - 1 + HEADINGS.length) % HEADINGS.length;
      setState("headingIndex", prev);
      setState("heading", HEADINGS[prev]);
    };
    const toggleCycling = () => {
      if (cycling()) {
        clearTimeout(cycleTimer);
        cycleTimer = undefined;
        setState("cycling", false);
        return;
      }
      setState("cycling", true);
      const tick = () => {
        if (!cycling()) return;
        nextHeading();
        cycleTimer = setTimeout(tick, 850 + Math.floor(Math.random() * 550));
      };
      cycleTimer = setTimeout(tick, 850 + Math.floor(Math.random() * 550));
    };
    const clearHeading = () => {
      setState("heading", undefined);
      if (cycling()) {
        clearTimeout(cycleTimer);
        cycleTimer = undefined;
        setState("cycling", false);
      }
    };
    onCleanup(() => {
      if (cycleTimer) clearTimeout(cycleTimer);
    });
    const vars = () => ({
      "--h-duration": \`\${duration()}ms\`,
      "--h-duration-raw": \`\${duration()}\`,
      "--h-blur": \`\${blur()}px\`,
      "--h-travel": \`\${travel()}px\`,
      "--h-spring": \`cubic-bezier(0.34, \${bounce()}, 0.64, 1)\`,
      "--h-spring-soft": \`cubic-bezier(0.34, \${Math.max(bounce() * 0.7, 1)}, 0.64, 1)\`,
      "--h-mask-size": \`\${maskSize()}px\`,
      "--h-mask-pad": \`\${maskPad()}px\`,
      "--h-mask-height": \`\${maskHeight()}px\`,
      "--h-mask-bg": "#1a1a1a"
    });
    return <div style={{
      display: "grid",
      gap: "24px",
      padding: "20px",
      "max-width": "820px",
      ...vars()
    }}>
        <style>{STYLES}</style>

        {/* ── Variant cards ─────────────────────────────────── */}
        <div style={{
        display: "grid",
        "grid-template-columns": "1fr",
        gap: "16px"
      }}>
          <div style={cardStyle}>
            <span style={cardLabel}>TextReveal (production)</span>
            <span style={thinkingRow}>
              <TextShimmer text="Thinking" active={active()} />
              <span style={headingSlot}>
                <TextReveal text={heading()} duration={duration()} travel={25} edge={17} spring={\`cubic-bezier(0.34, \${bounce()}, 0.64, 1)\`} springSoft={\`cubic-bezier(0.34, \${Math.max(bounce() * 0.7, 1)}, 0.64, 1)\`} growOnly />
              </span>
            </span>
          </div>
          {VARIANTS.map(v => <div style={cardStyle}>
              <span style={cardLabel}>{v.label}</span>
              <span style={thinkingRow}>
                <TextShimmer text="Thinking" active={active()} />
                <span style={headingSlot}>
                  <AnimatedHeading text={heading()} variant={v.key} debug={v.key === "odometer" && debug()} odoBlur={v.key === "odometer" && odoBlur()} />
                </span>
              </span>
            </div>)}
        </div>

        {/* ── Sliders ──────────────────────────────────────── */}
        <div style={{
        "border-top": "1px solid var(--color-divider, #333)",
        "padding-top": "16px",
        display: "grid",
        gap: "10px"
      }}>
          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>duration</span>
            <input type="range" class="heading-slider" min={200} max={1400} step={50} value={duration()} onInput={e => setState("duration", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{duration()}ms</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>blur</span>
            <input type="range" class="heading-slider" min={0} max={16} step={0.5} value={blur()} onInput={e => setState("blur", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{blur()}px</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>travel</span>
            <input type="range" class="heading-slider" min={4} max={120} step={1} value={travel()} onInput={e => setState("travel", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{travel()}px</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>bounce</span>
            <input type="range" class="heading-slider" min={1} max={2.2} step={0.05} value={bounce()} onInput={e => setState("bounce", Number(e.currentTarget.value))} />
            <span style={sliderValue}>
              {bounce().toFixed(2)} {bounce() <= 1.05 ? "(none)" : bounce() >= 1.9 ? "(heavy)" : ""}
            </span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>mask</span>
            <input type="range" class="heading-slider" min={0} max={50} step={1} value={maskSize()} onInput={e => setState("maskSize", Number(e.currentTarget.value))} />
            <span style={sliderValue}>
              {maskSize()}px {maskSize() === 0 ? "(hard)" : ""}
            </span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>mask pad</span>
            <input type="range" class="heading-slider" min={0} max={60} step={1} value={maskPad()} onInput={e => setState("maskPad", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{maskPad()}px</span>
          </div>

          <div style={{
          display: "flex",
          "align-items": "center",
          gap: "12px"
        }}>
            <span style={sliderLabel}>mask height</span>
            <input type="range" class="heading-slider" min={0} max={80} step={1} value={maskHeight()} onInput={e => setState("maskHeight", Number(e.currentTarget.value))} />
            <span style={sliderValue}>{maskHeight()}px</span>
          </div>
        </div>

        {/* ── Controls ─────────────────────────────────────── */}
        <div style={{
        display: "grid",
        gap: "12px"
      }}>
          <div style={{
          display: "flex",
          gap: "8px",
          "flex-wrap": "wrap"
        }}>
            <button onClick={toggleCycling} style={btn(cycling())}>
              {cycling() ? "Stop sim" : "Simulate jitter"}
            </button>
            <button onClick={prevHeading} style={btn()}>
              Prev
            </button>
            <button onClick={nextHeading} style={btn()}>
              Next
            </button>
            <button onClick={clearHeading} style={btn()}>
              Clear
            </button>
            <button onClick={() => setState("active", value => !value)} style={smallBtn(active())}>
              {active() ? "Shimmer: on" : "Shimmer: off"}
            </button>
            <button onClick={() => setState("debug", value => !value)} style={smallBtn(debug())}>
              {debug() ? "Debug mask: on" : "Debug mask"}
            </button>
            <button onClick={() => setState("odoBlur", value => !value)} style={smallBtn(odoBlur())}>
              {odoBlur() ? "Odo blur: on" : "Odo blur"}
            </button>
          </div>

          <div style={{
          display: "flex",
          gap: "6px",
          "flex-wrap": "wrap"
        }}>
            {HEADINGS.map((h, i) => <button onClick={() => {
            setState("headingIndex", i);
            setState("heading", h);
          }} style={smallBtn(headingIndex() === i)}>
                {h ?? "(no submessage)"}
              </button>)}
          </div>

          <div style={{
          "font-size": "11px",
          color: "var(--color-text-weak, #888)",
          "font-family": "monospace"
        }}>
            heading: {heading() ?? "(none)"} · sim: {cycling() ? "on" : "off"} · bounce: {bounce().toFixed(2)} ·
            odo-blur: {odoBlur() ? "on" : "off"}
          </div>
        </div>
      </div>;
  }
}`,...Q.parameters?.docs?.source}}};ka(["input","click"]);const Ma=["Playground"];export{Q as Playground,Ma as __namedExportsOrder,Ea as default};
