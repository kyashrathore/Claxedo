import{c as I,aV as ct,a as dt,n as vt,Z as J,o as K,ad as A,i as d,K as _,ac as gt,ab as y,a9 as k,t as O,b as f,aa as ut}from"./iframe-D288tw9h.js";import{c as q}from"./index-JyPbtXm1.js";import{f as xt,i as mt,J as ht,m as L}from"./is-motion-value-DTVMTkbm.js";import"./preload-helper-D9Z9MdNV.js";function ft(t,i,a={}){const e=t.get();let n=null,r=e,v;const g=typeof e=="string"?e.replace(/[\d.-]/g,""):void 0,h=()=>{n&&(n.stop(),n=null),t.animation=void 0},x=()=>{const s=P(t.get()),o=P(r);if(s===o){h();return}const l=n?n.getGeneratorVelocity():t.getVelocity();h(),n=new ht({keyframes:[s,o],velocity:l,type:"spring",restDelta:.001,restSpeed:.01,...a,onUpdate:v})},m=()=>{x(),t.animation=n??void 0,t.events.animationStart?.notify(),n?.then(()=>{t.animation=void 0,t.events.animationComplete?.notify()})};if(t.attach((s,o)=>{r=s,v=l=>o(N(l,g)),xt.postRender(m)},h),mt(i)){let s=a.skipInitialAnimation===!0;const o=i.on("change",p=>{s?(s=!1,t.jump(N(p,g),!1)):t.set(N(p,g))}),l=t.on("destroy",o);return()=>{o(),l()}}return h}function N(t,i){return i?t+i:t}function P(t){return typeof t=="number"?t:parseFloat(t)}function z(t,i,a){return ft(t,i,{type:"spring",...a})}const pt=(t,i)=>t?.visualDuration===i?.visualDuration&&t?.bounce===i?.bounce&&t?.stiffness===i?.stiffness&&t?.damping===i?.damping&&t?.mass===i?.mass&&t?.velocity===i?.velocity;function W(t,i,a){const e=()=>typeof i=="function"?i():i,[n,r]=I(t()),v=L(n()),g=L(n());let h=e(),x=z(g,v,h),m=g.on("change",s=>r(s));return ct(()=>{const s=t();v.set(s)}),dt(()=>{if(!i)return;const s=e();pt(h,s)||(h=s,x(),x=z(g,v,s),r(g.get()))}),vt(()=>{m(),x(),g.destroy(),v.destroy()}),n}var yt=O('<span data-component=text-strikethrough style=display:grid><span style="grid-area:1 / 1"></span><span aria-hidden=true style="grid-area:1 / 1;text-decoration:line-through;pointer-events:none">');function F(t){const i=W(()=>t.active?1:0,()=>({visualDuration:t.visualDuration??.35,bounce:0}));let a,e;const[n,r]=J({textWidth:0,containerWidth:0}),v=()=>n.textWidth,g=()=>n.containerWidth,h=()=>{a&&r("textWidth",a.scrollWidth),e&&r("containerWidth",e.offsetWidth)};K(h),q(()=>e,h);const x=()=>{const o=v();return o>0?i()*o:0},m=()=>{const o=g(),l=v();return o<=0||l<=0?`inset(0 ${(1-i())*100}% 0 0)`:`inset(0 ${Math.max(0,o-x())}px 0 0)`},s=()=>{const o=x();return o<=.5?"none":`inset(0 0 0 ${o}px)`};return(()=>{var o=yt(),l=o.firstChild,p=l.nextSibling,b=e;typeof b=="function"?A(b,o):e=o;var T=a;return typeof T=="function"?A(T,l):a=l,d(l,()=>t.text),d(p,()=>t.text),_(u=>{var E=t.class,R={...t.style},S=s(),$=m();return E!==u.e&&gt(o,u.e=E),u.t=y(o,R,u.t),S!==u.a&&k(l,"clip-path",u.a=S),$!==u.o&&k(p,"clip-path",u.o=$),u},{e:void 0,t:void 0,a:void 0,o:void 0}),o})()}var bt=O('<span style="position:relative;display:block;transition:color 220ms ease"><span style="position:absolute;left:0;right:0;top:50%;height:1.5px;background:currentColor;transform-origin:left center;pointer-events:none">'),kt=O('<span style="display:block;transition:color 220ms ease;background-image:linear-gradient(currentColor, currentColor);background-repeat:no-repeat;background-position:left center">'),Z=O('<span style="display:grid;transition:color 220ms ease"><span style="grid-area:1 / 1"></span><span aria-hidden=true style="grid-area:1 / 1;text-decoration:line-through;pointer-events:none">'),Tt=O("<div style=display:grid;gap:24px;padding:24px;max-width:700px><button></button><div><div>F — grid stacking + clip mapped to text width (THE COMPONENT)</div><div style=margin-top:12px></div><div style=margin-top:12px></div></div><div><div>F (inline) — same but just inline variants</div><div style=margin-top:12px></div><div style=margin-top:12px></div></div><div><div>E — grid stacking + clip-path (container %)</div><div style=margin-top:12px></div><div style=margin-top:12px></div></div><div><div>A — scaleX line at 50%</div><div style=margin-top:12px></div></div><div><div>D — background-image line</div><div style=margin-top:12px>");const w="Remove inline measure nodes",M="Remove inline measure nodes and keep width morph behavior intact",V="Refactor ToolStatusTitle DOM measurement to offscreen global measurer (unconstrained by timeline layout)",St=t=>({padding:"8px 18px","border-radius":"6px",border:"1px solid var(--color-divider, #444)",background:t?"var(--color-accent, #58f)":"var(--color-fill-element, #222)",color:"var(--color-text, #eee)",cursor:"pointer","font-size":"14px","font-weight":"500"}),C={"font-size":"11px","font-weight":"600","text-transform":"uppercase","letter-spacing":"0.05em",color:"var(--text-weak, #888)","margin-bottom":"4px"},D={padding:"16px 20px","border-radius":"10px",border:"1px solid var(--border-weak-base, #333)",background:"var(--surface-base, #1a1a1a)"};function U(t){const i=W(()=>t.active?1:0,()=>({visualDuration:.35,bounce:0}));return(()=>{var a=bt(),e=a.firstChild;return d(a,()=>t.text,e),_(n=>{var r=t.active?"var(--text-weak, #888)":"var(--text-strong, #eee)",v=`scaleX(${i()})`;return r!==n.e&&k(a,"color",n.e=r),v!==n.t&&k(e,"transform",n.t=v),n},{e:void 0,t:void 0}),a})()}function j(t){const i=W(()=>t.active?1:0,()=>({visualDuration:.35,bounce:0}));return(()=>{var a=kt();return d(a,()=>t.text),_(e=>{var n=t.active?"var(--text-weak, #888)":"var(--text-strong, #eee)",r=`${i()*100}% 1.5px`;return n!==e.e&&k(a,"color",e.e=n),r!==e.t&&k(a,"background-size",e.t=r),e},{e:void 0,t:void 0}),a})()}function H(t){const i=W(()=>t.active?1:0,()=>({visualDuration:.35,bounce:0}));return(()=>{var a=Z(),e=a.firstChild,n=e.nextSibling;return d(e,()=>t.text),d(n,()=>t.text),_(r=>{var v=t.active?"var(--text-weak, #888)":"var(--text-strong, #eee)",g=`inset(0 ${(1-i())*100}% 0 0)`;return v!==r.e&&k(a,"color",r.e=v),g!==r.t&&k(n,"clip-path",r.t=g),r},{e:void 0,t:void 0}),a})()}function G(t){const i=W(()=>t.active?1:0,()=>({visualDuration:.35,bounce:0}));let a,e;const[n,r]=J({textWidth:0,containerWidth:0}),v=()=>n.textWidth,g=()=>n.containerWidth,h=()=>{a&&r("textWidth",a.scrollWidth),e&&r("containerWidth",e.offsetWidth)};K(h),q(()=>e,h);const x=()=>{const m=g(),s=v();if(m<=0||s<=0)return`${(1-i())*100}%`;const o=i()*s;return`${Math.max(0,m-o)}px`};return(()=>{var m=Z(),s=m.firstChild,o=s.nextSibling,l=e;typeof l=="function"?A(l,m):e=m;var p=a;return typeof p=="function"?A(p,s):a=s,d(s,()=>t.text),d(o,()=>t.text),_(b=>{var T=t.active?"var(--text-weak, #888)":"var(--text-strong, #eee)",u=`inset(0 ${x()} 0 0)`;return T!==b.e&&k(m,"color",b.e=T),u!==b.t&&k(o,"clip-path",b.t=u),b},{e:void 0,t:void 0}),m})()}const Vt={title:"UI/Text Strikethrough",id:"components-text-strikethrough",tags:["autodocs"],parameters:{docs:{description:{component:`### Animated Strikethrough Variants

- **A** — scaleX line at 50% (single line only)
- **D** — background-image line (single line only)
- **E** — grid stacking + clip-path (container %)
- **F** — grid stacking + clip-path mapped to text width (the real component)`}}}},X={render:()=>{const[t,i]=I(!1),a=()=>i(e=>!e);return(()=>{var e=Tt(),n=e.firstChild,r=n.nextSibling,v=r.firstChild,g=v.nextSibling,h=g.nextSibling,x=r.nextSibling,m=x.firstChild,s=m.nextSibling,o=s.nextSibling,l=x.nextSibling,p=l.firstChild,b=p.nextSibling,T=b.nextSibling,u=l.nextSibling,E=u.firstChild,R=E.nextSibling,S=u.nextSibling,$=S.firstChild,B=$.nextSibling;return n.$$click=a,d(n,()=>t()?"Undo strikethrough":"Strike through all"),d(r,f(F,{get active(){return t()},text:w,get style(){return{color:t()?"var(--text-weak, #888)":"var(--text-strong, #eee)",transition:"color 220ms ease"}}}),g),d(r,f(F,{get active(){return t()},text:M,get style(){return{color:t()?"var(--text-weak, #888)":"var(--text-strong, #eee)",transition:"color 220ms ease"}}}),h),d(r,f(F,{get active(){return t()},text:V,get style(){return{color:t()?"var(--text-weak, #888)":"var(--text-strong, #eee)",transition:"color 220ms ease"}}}),null),d(x,f(G,{get active(){return t()},text:w}),s),d(x,f(G,{get active(){return t()},text:M}),o),d(x,f(G,{get active(){return t()},text:V}),null),d(l,f(H,{get active(){return t()},text:w}),b),d(l,f(H,{get active(){return t()},text:M}),T),d(l,f(H,{get active(){return t()},text:V}),null),d(u,f(U,{get active(){return t()},text:w}),R),d(u,f(U,{get active(){return t()},text:V}),null),d(S,f(j,{get active(){return t()},text:w}),B),d(S,f(j,{get active(){return t()},text:V}),null),_(c=>{var Q=St(t()),Y=D,tt=C,et=D,nt=C,it=D,at=C,rt=D,ot=C,st=D,lt=C;return c.e=y(n,Q,c.e),c.t=y(r,Y,c.t),c.a=y(v,tt,c.a),c.o=y(x,et,c.o),c.i=y(m,nt,c.i),c.n=y(l,it,c.n),c.s=y(p,at,c.s),c.h=y(u,rt,c.h),c.r=y(E,ot,c.r),c.d=y(S,st,c.d),c.l=y($,lt,c.l),c},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0,r:void 0,d:void 0,l:void 0}),e})()}};X.parameters={...X.parameters,docs:{...X.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [active, setActive] = createSignal(false);
    const toggle = () => setActive(v => !v);
    return <div style={{
      display: "grid",
      gap: "24px",
      padding: "24px",
      "max-width": "700px"
    }}>
        <button onClick={toggle} style={btn(active())}>
          {active() ? "Undo strikethrough" : "Strike through all"}
        </button>

        <div style={card}>
          <div style={heading}>F — grid stacking + clip mapped to text width (THE COMPONENT)</div>
          <TextStrikethrough active={active()} text={TEXT_SHORT} style={{
          color: active() ? "var(--text-weak, #888)" : "var(--text-strong, #eee)",
          transition: "color 220ms ease"
        }} />
          <div style={{
          "margin-top": "12px"
        }} />
          <TextStrikethrough active={active()} text={TEXT_MED} style={{
          color: active() ? "var(--text-weak, #888)" : "var(--text-strong, #eee)",
          transition: "color 220ms ease"
        }} />
          <div style={{
          "margin-top": "12px"
        }} />
          <TextStrikethrough active={active()} text={TEXT_LONG} style={{
          color: active() ? "var(--text-weak, #888)" : "var(--text-strong, #eee)",
          transition: "color 220ms ease"
        }} />
        </div>

        <div style={card}>
          <div style={heading}>F (inline) — same but just inline variants</div>
          <VariantF active={active()} text={TEXT_SHORT} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantF active={active()} text={TEXT_MED} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantF active={active()} text={TEXT_LONG} />
        </div>

        <div style={card}>
          <div style={heading}>E — grid stacking + clip-path (container %)</div>
          <VariantE active={active()} text={TEXT_SHORT} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantE active={active()} text={TEXT_MED} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantE active={active()} text={TEXT_LONG} />
        </div>

        <div style={card}>
          <div style={heading}>A — scaleX line at 50%</div>
          <VariantA active={active()} text={TEXT_SHORT} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantA active={active()} text={TEXT_LONG} />
        </div>

        <div style={card}>
          <div style={heading}>D — background-image line</div>
          <VariantD active={active()} text={TEXT_SHORT} />
          <div style={{
          "margin-top": "12px"
        }} />
          <VariantD active={active()} text={TEXT_LONG} />
        </div>
      </div>;
  }
}`,...X.parameters?.docs?.source}}};ut(["click"]);const Ct=["Playground"];export{X as Playground,Ct as __namedExportsOrder,Vt as default};
