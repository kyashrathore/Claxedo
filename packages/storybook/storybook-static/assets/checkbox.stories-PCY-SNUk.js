import{b as s,i as n,t as i}from"./iframe-D288tw9h.js";import{I as m}from"./icon-BG5j3Qjr.js";import{m as l,C as a}from"./checkbox-D9d9pO4O.js";import{c as p}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./3PUKRKSL-lXEBGSVb.js";import"./VI7QYH27-BdSgIyCK.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";var h=i("<div style=display:grid;gap:12px>");const u=`### Overview
Checkbox control for multi-select or agreement inputs.

Use in forms and multi-select lists.

### API
- Uses Kobalte Checkbox props (\`checked\`, \`defaultChecked\`, \`onChange\`).
- Optional: \`hideLabel\`, \`description\`, \`icon\`.
- Children render as the label.

### Variants and states
- Checked/unchecked, indeterminate, disabled (via Kobalte).

### Behavior
- Controlled or uncontrolled usage.

### Accessibility
- TODO: confirm aria attributes from Kobalte.

### Theming/tokens
- Uses \`data-component="checkbox"\` and related slots.

`,d=p({title:"UI/Checkbox",mod:l,args:{children:"Checkbox",defaultChecked:!0}}),U={title:"UI/Checkbox",id:"components-checkbox",component:d.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:u}}}},e=d.Basic,o={render:()=>(()=>{var t=h();return n(t,s(a,{defaultChecked:!0,children:"Checked"}),null),n(t,s(a,{children:"Unchecked"}),null),n(t,s(a,{disabled:!0,children:"Disabled"}),null),n(t,s(a,{description:"Helper text",children:"With description"}),null),t})()},r={render:()=>s(a,{get icon(){return s(m,{name:"check",size:"small"})},defaultChecked:!0,children:"Custom icon"})},c={args:{children:"Hidden label",hideLabel:!0}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  43 | }
  44 |
> 45 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  46 |
  47 | export const States = {
  48 |   render: () => (`,...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Checkbox defaultChecked>Checked</mod.Checkbox>
    <mod.Checkbox>Unchecked</mod.Checkbox>
    <mod.Checkbox disabled>Disabled</mod.Checkbox>
    <mod.Checkbox description="Helper text">With description</mod.Checkbox>
  </div>
);
`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const CustomIcon = () => (
  <mod.Checkbox icon={<Icon name="check" size="small" />} defaultChecked>
    Custom icon
  </mod.Checkbox>
);
`,...r.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const HiddenLabel = () => (
  <story.meta.component hideLabel>Hidden label</story.meta.component>
);
`,...c.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Checkbox defaultChecked>Checked</mod.Checkbox>
      <mod.Checkbox>Unchecked</mod.Checkbox>
      <mod.Checkbox disabled>Disabled</mod.Checkbox>
      <mod.Checkbox description="Helper text">With description</mod.Checkbox>
    </div>
}`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <mod.Checkbox icon={<Icon name="check" size="small" />} defaultChecked>
      Custom icon
    </mod.Checkbox>
}`,...r.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  args: {
    children: "Hidden label",
    hideLabel: true
  }
}`,...c.parameters?.docs?.source}}};const B=["Basic","States","CustomIcon","HiddenLabel"];export{e as Basic,r as CustomIcon,c as HiddenLabel,o as States,B as __namedExportsOrder,U as default};
