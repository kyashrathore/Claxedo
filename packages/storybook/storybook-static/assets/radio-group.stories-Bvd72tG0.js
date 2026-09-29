import{b as t,i as n,t as l}from"./iframe-D288tw9h.js";import{m as p,R as i}from"./radio-group-CreiIXtP.js";import{c}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./H7BK6JF7-Auk6LkTy.js";import"./ZZYKR3VO-DWSPmSPl.js";import"./index-BSkhwO4U.js";var m=l("<div style=display:grid;gap:12px>");const u=`### Overview
Segmented radio group for choosing a single option.

Use for view toggles or mode selection.

### API
- Required: \`options\`.
- Optional: \`current\`, \`defaultValue\`, \`value\`, \`label\`, \`onSelect\`.
- Optional layout: \`size\`, \`fill\`, \`pad\`.

### Variants and states
- Size variants: small, medium.
- Optional fill and padding behavior.

### Behavior
- Maps options to segmented items and manages selection.

### Accessibility
- TODO: confirm role/aria attributes from Kobalte SegmentedControl.

### Theming/tokens
- Uses \`data-component="radio-group"\` with size/pad data attributes.

`,d=c({title:"UI/RadioGroup",mod:p,args:{options:["One","Two","Three"],defaultValue:"One"}}),z={title:"UI/RadioGroup",id:"components-radio-group",component:d.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:u}}},argTypes:{size:{control:"select",options:["small","medium"]},pad:{control:"select",options:["none","normal"]},fill:{control:"boolean"}}},e=d.Basic,o={render:()=>(()=>{var r=m();return n(r,t(i,{options:["One","Two"],defaultValue:"One",size:"small"}),null),n(r,t(i,{options:["One","Two"],defaultValue:"One",size:"medium"}),null),r})()},s={args:{fill:!0,pad:"none"}},a={render:()=>t(i,{options:["list","grid"],defaultValue:"list",label:r=>r==="list"?"List view":"Grid view"})};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  64 | }
  65 |
> 66 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  67 |
  68 | export const Sizes = {
  69 |   render: () => (`,...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.RadioGroup options={["One", "Two"]} defaultValue="One" size="small" />
    <mod.RadioGroup options={["One", "Two"]} defaultValue="One" size="medium" />
  </div>
);
`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Filled = () => <story.meta.component fill pad="none" />;
`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const CustomLabels = () => (
  <mod.RadioGroup
    options={["list", "grid"]}
    defaultValue="list"
    label={(value) => (value === "list" ? "List view" : "Grid view")}
  />
);
`,...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.RadioGroup options={["One", "Two"]} defaultValue="One" size="small" />
      <mod.RadioGroup options={["One", "Two"]} defaultValue="One" size="medium" />
    </div>
}`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    fill: true,
    pad: "none"
  }
}`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <mod.RadioGroup options={["list", "grid"]} defaultValue="list" label={value => value === "list" ? "List view" : "Grid view"} />
}`,...a.parameters?.docs?.source}}};const G=["Basic","Sizes","Filled","CustomLabels"];export{e as Basic,a as CustomLabels,s as Filled,o as Sizes,G as __namedExportsOrder,z as default};
