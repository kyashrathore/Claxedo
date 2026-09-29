import{i as n,b as r,t as a}from"./iframe-D288tw9h.js";import{m as p,S as i}from"./spinner-BtVIucLM.js";import{c}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var d=a("<div style=display:flex;gap:16px;align-items:center>");const l=`### Overview
Animated loading indicator for inline or page-level loading states.

Use with \`Button\` or in empty states.

### API
- Accepts standard SVG props (class, style).

### Variants and states
- Single default animation style.

### Behavior
- Animation is CSS-driven via data attributes.

### Accessibility
- Use alongside text or aria-live regions to convey loading state.

### Theming/tokens
- Uses \`data-component="spinner"\` for styling hooks.

`,o=c({title:"UI/Spinner",mod:p}),y={title:"UI/Spinner",id:"components-spinner",component:o.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:l}}}},e=o.Basic,t={render:()=>(()=>{var s=d();return n(s,r(i,{style:{width:"12px",height:"12px"}}),null),n(s,r(i,{style:{width:"20px",height:"20px"}}),null),n(s,r(i,{style:{width:"28px",height:"28px"}}),null),s})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  41 | }
  42 |
> 43 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  44 |
  45 | export const Sizes = {
  46 |   render: () => (`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <mod.Spinner style={{ width: "12px", height: "12px" }} />
    <mod.Spinner style={{ width: "20px", height: "20px" }} />
    <mod.Spinner style={{ width: "28px", height: "28px" }} />
  </div>
);
`,...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <mod.Spinner style={{
      width: "12px",
      height: "12px"
    }} />
      <mod.Spinner style={{
      width: "20px",
      height: "20px"
    }} />
      <mod.Spinner style={{
      width: "28px",
      height: "28px"
    }} />
    </div>
}`,...t.parameters?.docs?.source}}};const u=["Basic","Sizes"];export{e as Basic,t as Sizes,u as __namedExportsOrder,y as default};
