import{i as t,b as i,t as m}from"./iframe-D288tw9h.js";import{m as d,I as c}from"./icon-button-C_HG_auw.js";import{c as p}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var s=m("<div style=display:flex;gap:12px;align-items:center>");const u=`### Overview
Compact icon-only button with size and variant control.

Use \`Button\` for text labels and primary actions.

### API
- Required: \`icon\` icon name.
- Optional: \`size\`, \`iconSize\`, \`variant\`.
- Inherits Kobalte Button props and native button attributes.

### Variants and states
- Variants: primary, secondary, ghost.
- Sizes: small, normal, large.

### Behavior
- Icon size adapts to button size unless overridden.

### Accessibility
- Provide \`aria-label\` when there is no visible text.

### Theming/tokens
- Uses \`data-component="icon-button"\` and size/variant data attributes.

`,l=p({title:"UI/IconButton",mod:d,args:{icon:"check","aria-label":"Icon"}}),I={title:"UI/IconButton",id:"components-icon-button",component:l.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:u}}}},a=l.Basic,n={render:()=>(()=>{var e=s();return t(e,i(c,{icon:"check",size:"small","aria-label":"Small"}),null),t(e,i(c,{icon:"check",size:"normal","aria-label":"Normal"}),null),t(e,i(c,{icon:"check",size:"large","aria-label":"Large"}),null),e})()},r={render:()=>(()=>{var e=s();return t(e,i(c,{icon:"check",variant:"primary","aria-label":"Primary"}),null),t(e,i(c,{icon:"check",variant:"secondary","aria-label":"Secondary"}),null),t(e,i(c,{icon:"check",variant:"ghost","aria-label":"Ghost"}),null),e})()},o={render:()=>(()=>{var e=s();return t(e,i(c,{icon:"check",size:"small",iconSize:"large","aria-label":"Small with large icon"}),null),t(e,i(c,{icon:"check",size:"large",iconSize:"small","aria-label":"Large with small icon"}),null),e})()};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  43 | }
  44 |
> 45 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  46 |
  47 | export const Sizes = {
  48 |   render: () => (`,...a.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <mod.IconButton icon="check" size="small" aria-label="Small" />
    <mod.IconButton icon="check" size="normal" aria-label="Normal" />
    <mod.IconButton icon="check" size="large" aria-label="Large" />
  </div>
);
`,...n.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Variants = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <mod.IconButton icon="check" variant="primary" aria-label="Primary" />
    <mod.IconButton icon="check" variant="secondary" aria-label="Secondary" />
    <mod.IconButton icon="check" variant="ghost" aria-label="Ghost" />
  </div>
);
`,...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const IconSizeOverride = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <mod.IconButton
      icon="check"
      size="small"
      iconSize="large"
      aria-label="Small with large icon"
    />
    <mod.IconButton
      icon="check"
      size="large"
      iconSize="small"
      aria-label="Large with small icon"
    />
  </div>
);
`,...o.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:"story.Basic",...a.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <mod.IconButton icon="check" size="small" aria-label="Small" />
      <mod.IconButton icon="check" size="normal" aria-label="Normal" />
      <mod.IconButton icon="check" size="large" aria-label="Large" />
    </div>
}`,...n.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <mod.IconButton icon="check" variant="primary" aria-label="Primary" />
      <mod.IconButton icon="check" variant="secondary" aria-label="Secondary" />
      <mod.IconButton icon="check" variant="ghost" aria-label="Ghost" />
    </div>
}`,...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <mod.IconButton icon="check" size="small" iconSize="large" aria-label="Small with large icon" />
      <mod.IconButton icon="check" size="large" iconSize="small" aria-label="Large with small icon" />
    </div>
}`,...o.parameters?.docs?.source}}};const S=["Basic","Sizes","Variants","IconSizeOverride"];export{a as Basic,o as IconSizeOverride,n as Sizes,r as Variants,S as __namedExportsOrder,I as default};
