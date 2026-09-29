import{s as i,I as d,m as p,t,i as l,b as c}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var v=t("<div>");function o(s){const[r,n]=i(s,["class","classList"]);return(()=>{var a=v();return d(a,p(n,{role:"separator","aria-orientation":"horizontal","data-component":"divider-v2",get classList(){return{...r.classList,[r.class??""]:!!r.class}}}),!1,!1),a})()}var m=t("<div style=display:flex;flex-direction:column;gap:16px;padding:16px><span>Above</span><span>Below");const u=`### Overview
Horizontal hairline divider for v2 layouts.

### API
- Inherits native div attributes.
- Stretches to full width of its flex parent.

### Theming/tokens
- Uses \`data-component="divider-v2"\`.
- Border color: \`--v2-border-border-strong\`.
`,g={title:"UI V2/Divider",id:"components-divider-v2",component:o,tags:["autodocs"],parameters:{frameWidth:"320px",docs:{description:{component:u}}}},e={render:()=>(()=>{var s=m(),r=s.firstChild,n=r.nextSibling;return l(s,c(o,{}),n),s})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => (
  <div
    style={{
      display: "flex",
      "flex-direction": "column",
      gap: "16px",
      padding: "16px",
    }}
  >
    <span>Above</span>
    <DividerV2 />
    <span>Below</span>
  </div>
);
`,...e.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    "flex-direction": "column",
    gap: "16px",
    padding: "16px"
  }}>
      <span>Above</span>
      <DividerV2 />
      <span>Below</span>
    </div>
}`,...e.parameters?.docs?.source}}};const _=["Basic"];export{e as Basic,_ as __namedExportsOrder,g as default};
