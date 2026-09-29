import{i as c,b as m,t as d}from"./iframe-D288tw9h.js";import{B as i}from"./button-Bsz0PTzb.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var l=d("<div style=display:flex;gap:12px;align-items:center>");const p=`### Overview
Primary action button with size, variant, and optional icon support.

Use \`IconButton\` for icon-only actions.

### API
- \`variant\`: "primary" | "secondary" | "ghost".
- \`size\`: "small" | "normal" | "large".
- \`icon\`: Icon name for a leading icon.
- Inherits Kobalte Button props and native button attributes.

### Variants and states
- Variants: primary, secondary, ghost.
- States: disabled.

### Behavior
- Renders an Icon when \`icon\` is set.

### Accessibility
- Provide clear label text; use \`aria-label\` for icon-only buttons.

### Theming/tokens
- Uses \`data-component="button"\` with size/variant data attributes.

`,z={title:"UI/Button",id:"components-button",component:i,tags:["autodocs"],parameters:{docs:{description:{component:p}}},args:{children:"Button",variant:"secondary",size:"normal"},argTypes:{variant:{control:"select",options:["primary","secondary","ghost"]},size:{control:"select",options:["small","normal","large"]},icon:{control:"select",options:["none","check","plus","arrow-right"],mapping:{none:void 0}}}},r={args:{variant:"primary"}},a={},e={args:{variant:"ghost"}},n={args:{children:"Continue",icon:"arrow-right"}},t={args:{variant:"primary",disabled:!0}},o={render:()=>(()=>{var s=l();return c(s,m(i,{size:"small",variant:"secondary",children:"Small"}),null),c(s,m(i,{size:"normal",variant:"secondary",children:"Normal"}),null),c(s,m(i,{size:"large",variant:"secondary",children:"Large"}),null),s})()};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Primary = () => (
  <Button variant="primary" size="normal">
    Button
  </Button>
);
`,...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Secondary = () => (
  <Button variant="secondary" size="normal">
    Button
  </Button>
);
`,...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Ghost = () => (
  <Button variant="ghost" size="normal">
    Button
  </Button>
);
`,...e.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const WithIcon = () => (
  <Button variant="secondary" size="normal" icon="arrow-right">
    Continue
  </Button>
);
`,...n.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Disabled = () => (
  <Button variant="primary" size="normal" disabled>
    Button
  </Button>
);
`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <Button size="small" variant="secondary">
      Small
    </Button>
    <Button size="normal" variant="secondary">
      Normal
    </Button>
    <Button size="large" variant="secondary">
      Large
    </Button>
  </div>
);
`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "primary"
  }
}`,...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:"{}",...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "ghost"
  }
}`,...e.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  args: {
    children: "Continue",
    icon: "arrow-right"
  }
}`,...n.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "primary",
    disabled: true
  }
}`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <Button size="small" variant="secondary">
        Small
      </Button>
      <Button size="normal" variant="secondary">
        Normal
      </Button>
      <Button size="large" variant="secondary">
        Large
      </Button>
    </div>
}`,...o.parameters?.docs?.source}}};const b=["Primary","Secondary","Ghost","WithIcon","Disabled","Sizes"];export{t as Disabled,e as Ghost,r as Primary,a as Secondary,o as Sizes,n as WithIcon,b as __namedExportsOrder,z as default};
