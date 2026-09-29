import{s as l,I as p,m as h,t as c,b as o,i as n}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var m=c('<svg><circle cx=8 cy=8 r=6 data-slot=loader-v2-background stroke-width=2></circle><circle cx=8 cy=8 r=6 data-slot=loader-v2-progress pathLength=100 stroke-width=2 stroke-dasharray="33 67">');function s(t){const[a,d]=l(t,["class","classList","width","height"]);return(()=>{var i=m();return p(i,h(d,{get class(){return a.class},get classList(){return{"ui-loader-v2":!0,...a.classList}},get width(){return a.width??16},get height(){return a.height??16},viewBox:"0 0 16 16",fill:"none",xmlns:"http://www.w3.org/2000/svg","data-component":"loader-v2",get"aria-hidden"(){return d["aria-hidden"]??"true"}}),!0,!0),i})()}var u=c("<div style=display:flex;gap:16px;align-items:center>");const g=`### Overview
Circular v2 loader for compact loading states.

### API
- Accepts standard SVG props.

### Behavior
- The foreground ring covers 33% of the circumference and rotates continuously.

### Accessibility
- Sets \`aria-hidden="true"\` by default.
`,L={title:"UI V2/Loader",id:"components-loader-v2",component:s,tags:["autodocs"],parameters:{docs:{description:{component:g}}}},e={render:()=>o(s,{})},r={render:()=>(()=>{var t=u();return n(t,o(s,{width:12,height:12}),null),n(t,o(s,{}),null),n(t,o(s,{width:24,height:24}),null),t})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => <LoaderV2 />;
`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <LoaderV2 width={12} height={12} />
    <LoaderV2 />
    <LoaderV2 width={24} height={24} />
  </div>
);
`,...r.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <LoaderV2 />
}`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <LoaderV2 width={12} height={12} />
      <LoaderV2 />
      <LoaderV2 width={24} height={24} />
    </div>
}`,...r.parameters?.docs?.source}}};const f=["Basic","Sizes"];export{e as Basic,r as Sizes,f as __namedExportsOrder,L as default};
