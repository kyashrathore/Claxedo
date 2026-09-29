import{s as k,I as y,m as h,i as c,b as l,t as p,L as g,K as z,S}from"./iframe-D288tw9h.js";import{c as x}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var A=p("<div>"),_=p("<img data-slot=avatar-image>");const f=typeof Intl<"u"&&"Segmenter"in Intl?new Intl.Segmenter(void 0,{granularity:"grapheme"}):void 0;function I(e){return e?f?f.segment(e)[Symbol.iterator]().next().value?.segment??Array.from(e)[0]??"":Array.from(e)[0]??"":""}function i(e){const[a,b]=k(e,["fallback","src","background","foreground","size","class","classList","style"]),n=a.src;return(()=>{var m=A();return y(m,h(b,{"data-component":"avatar",get"data-size"(){return a.size||"normal"},"data-has-image":n?"":void 0,get classList(){return{"ui-avatar":!0,...a.classList,[a.class??""]:!!a.class}},get style(){return{...typeof a.style=="object"?a.style:{},...!n&&a.background?{"--avatar-bg":a.background}:{},...!n&&a.foreground?{"--avatar-fg":a.foreground}:{}}}}),!1,!0),c(m,l(S,{when:n,get fallback(){return I(a.fallback)},children:v=>(()=>{var d=_();return g(d,"draggable",!1),z(()=>g(d,"src",v())),d})()})),m})()}const C=Object.freeze(Object.defineProperty({__proto__:null,Avatar:i},Symbol.toStringTag,{value:"Module"}));var w=p("<div style=display:flex;gap:12px;align-items:center>");const B=`### Overview
User avatar with image fallback to initials.

Use in user lists and headers.

### API
- Required: \`fallback\` string.
- Optional: \`src\`, \`background\`, \`foreground\`, \`size\`.

### Variants and states
- Sizes: small, normal, large.
- Image vs fallback state.

### Behavior
- Uses grapheme-aware fallback rendering.

### Accessibility
- TODO: provide alt text when using images; currently image is decorative.

### Theming/tokens
- Uses \`data-component="avatar"\` with size and image state attributes.

`,u=x({title:"UI/Avatar",mod:C,args:{fallback:"A"}}),U={title:"UI/Avatar",id:"components-avatar",component:u.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:B}}},argTypes:{size:{control:"select",options:["small","normal","large"]}}},r=u.Basic,s={args:{src:"https://placehold.co/80x80/png",fallback:"J"}},t={render:()=>(()=>{var e=w();return c(e,l(i,{size:"small",fallback:"S"}),null),c(e,l(i,{size:"normal",fallback:"N"}),null),c(e,l(i,{size:"large",fallback:"L"}),null),e})()},o={args:{fallback:"C",background:"#1f2a44",foreground:"#f2f5ff"}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  49 | }
  50 |
> 51 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  52 |
  53 | export const WithImage = {
  54 |   args: {`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const WithImage = () => (
  <story.meta.component src="https://placehold.co/80x80/png" fallback="J" />
);
`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <mod.Avatar size="small" fallback="S" />
    <mod.Avatar size="normal" fallback="N" />
    <mod.Avatar size="large" fallback="L" />
  </div>
);
`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const CustomColors = () => (
  <story.meta.component
    fallback="C"
    background="#1f2a44"
    foreground="#f2f5ff"
  />
);
`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:"story.Basic",...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    src: "https://placehold.co/80x80/png",
    fallback: "J"
  }
}`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <mod.Avatar size="small" fallback="S" />
      <mod.Avatar size="normal" fallback="N" />
      <mod.Avatar size="large" fallback="L" />
    </div>
}`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    fallback: "C",
    background: "#1f2a44",
    foreground: "#f2f5ff"
  }
}`,...o.parameters?.docs?.source}}};const j=["Basic","WithImage","Sizes","CustomColors"];export{r as Basic,o as CustomColors,t as Sizes,s as WithImage,j as __namedExportsOrder,U as default};
