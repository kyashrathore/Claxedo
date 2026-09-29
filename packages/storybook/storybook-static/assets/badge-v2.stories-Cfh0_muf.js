import{s as p,I as g,m,i as o,t as d,b as i}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var u=d("<span>");function n(r){const[s,l]=p(r,["class","classList","children","variant"]);return(()=>{var c=u();return g(c,m(l,{"data-component":"tag",get"data-variant"(){return s.variant??"neutral"},get classList(){return{"ui-tag":!0,...s.classList,[s.class??""]:!!s.class}}}),!1,!0),o(c,()=>s.children),c})()}var h=d("<div style=display:flex;gap:8px;align-items:center>");const v=`### Overview
Small label tag for metadata and status chips.

Use alongside headings or lists for quick metadata.

### API
- Accepts standard span props.
- Optional: \`variant\` is \`neutral\` (default) or \`accent\`.
- Optional: \`data-high-contrast\` attribute for stronger border contrast.

### Variants and states
- Neutral and accent variants.
- Optional high-contrast border style.

### Behavior
- Inline element with fixed 16px height and tabular numeric text.

### Accessibility
- Ensure text conveys meaning; avoid color-only distinction.

### Theming/tokens
- Uses \`data-component="tag"\`.

`,f={title:"UI V2/Badge",id:"components-badge-v2",component:n,tags:["autodocs"],parameters:{docs:{description:{component:v}}},args:{children:"Label"}},a={},e={render:()=>(()=>{var r=h();return o(r,i(n,{children:"Label"}),null),o(r,i(n,{"data-high-contrast":!0,children:"Label"}),null),r})()},t={render:()=>i(n,{variant:"accent",children:"New"})};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Basic = () => <Tag>Label</Tag>;
`,...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const HighContrast = () => (
  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
    <Tag>Label</Tag>
    <Tag data-high-contrast>Label</Tag>
  </div>
);
`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Accent = () => <Tag variant="accent">New</Tag>;
`,...t.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:"{}",...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "8px",
    "align-items": "center"
  }}>
      <Tag>Label</Tag>
      <Tag data-high-contrast>Label</Tag>
    </div>
}`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <Tag variant="accent">New</Tag>
}`,...t.parameters?.docs?.source}}};const x=["Basic","HighContrast","Accent"];export{t as Accent,a as Basic,e as HighContrast,x as __namedExportsOrder,f as default};
