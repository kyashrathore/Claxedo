import{s as O,r as C,I as j,m as L,K as U,t as w,L as r,i as m,b as u}from"./iframe-D288tw9h.js";import{c as W}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var A=w("<svg><circle cx=8 cy=8 data-slot=progress-circle-background></circle><circle cx=8 cy=8 data-slot=progress-circle-background-overlay></circle><circle cx=8 cy=8 data-slot=progress-circle-progress>");function p(o){const[a,_]=O(o,["percentage","size","strokeWidth","class","classList"]),v=()=>a.size||16,i=()=>a.strokeWidth||3,I=16/2,n=()=>I-i()/2,h=C(()=>2*Math.PI*n()),M=C(()=>{const c=Math.max(0,Math.min(100,a.percentage||0))/100;return h()*(1-c)});return(()=>{var l=A(),c=l.firstChild,g=c.nextSibling,d=g.nextSibling;return j(l,L(_,{get width(){return v()},get height(){return v()},viewBox:"0 0 16 16",fill:"none","data-component":"progress-circle",get classList(){return{...a.classList,[a.class??""]:!!a.class}}}),!0,!0),U(e=>{var f=n(),x=i(),y=n(),z=i(),P=n(),b=i(),k=h().toString(),S=M();return f!==e.e&&r(c,"r",e.e=f),x!==e.t&&r(c,"stroke-width",e.t=x),y!==e.a&&r(g,"r",e.a=y),z!==e.o&&r(g,"stroke-width",e.o=z),P!==e.i&&r(d,"r",e.i=P),b!==e.n&&r(d,"stroke-width",e.n=b),k!==e.s&&r(d,"stroke-dasharray",e.s=k),S!==e.h&&r(d,"stroke-dashoffset",e.h=S),e},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0,s:void 0,h:void 0}),l})()}const E=Object.freeze(Object.defineProperty({__proto__:null,ProgressCircle:p},Symbol.toStringTag,{value:"Module"}));var T=w("<div style=display:flex;gap:16px;align-items:center>");const R=`### Overview
Circular progress indicator for compact loading states.

Pair with labels for clarity in dashboards.

### API
- Required: \`percentage\` (0-100).
- Optional: \`size\`, \`strokeWidth\`.

### Variants and states
- Single visual style; size and stroke width adjust appearance.

### Behavior
- Percentage is clamped between 0 and 100.

### Accessibility
- Use alongside text or aria-live messaging for progress context.

### Theming/tokens
- Uses \`data-component="progress-circle"\` with background/progress slots.

`,B=W({title:"UI/ProgressCircle",mod:E,args:{percentage:65,size:48}}),F={title:"UI/ProgressCircle",id:"components-progress-circle",component:B.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:R}}},argTypes:{percentage:{control:{type:"range",min:0,max:100,step:1}}}},s=B.Basic,t={render:()=>(()=>{var o=T();return m(o,u(p,{percentage:0,size:32}),null),m(o,u(p,{percentage:50,size:32}),null),m(o,u(p,{percentage:100,size:32}),null),o})()};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  47 | }
  48 |
> 49 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  50 |
  51 | export const States = {
  52 |   render: () => (`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <mod.ProgressCircle percentage={0} size={32} />
    <mod.ProgressCircle percentage={50} size={32} />
    <mod.ProgressCircle percentage={100} size={32} />
  </div>
);
`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:"story.Basic",...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <mod.ProgressCircle percentage={0} size={32} />
      <mod.ProgressCircle percentage={50} size={32} />
      <mod.ProgressCircle percentage={100} size={32} />
    </div>
}`,...t.parameters?.docs?.source}}};const G=["Basic","States"];export{s as Basic,t as States,G as __namedExportsOrder,F as default};
