import{s as m,I as p,m as g,i as o,t as c,b as i}from"./iframe-D288tw9h.js";import{c as u}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var z=c("<span>");function n(a){const[r,d]=m(a,["size","class","classList","children"]);return(()=>{var t=z();return p(t,g(d,{"data-component":"tag",get"data-size"(){return r.size||"normal"},get classList(){return{"ui-tag":!0,...r.classList,[r.class??""]:!!r.class}}}),!1,!0),o(t,()=>r.children),t})()}const y=Object.freeze(Object.defineProperty({__proto__:null,Tag:n},Symbol.toStringTag,{value:"Module"}));var v=c("<div style=display:flex;gap:8px;align-items:center>");const f=`### Overview
Small label tag for metadata and status chips.

Use alongside headings or lists for quick metadata.

### API
- Optional: \`size\` (normal | large).
- Accepts standard span props.

### Variants and states
- Size variants only.

### Behavior
- Inline element; size controls padding and font size via CSS.

### Accessibility
- Ensure text conveys meaning; avoid color-only distinction.

### Theming/tokens
- Uses \`data-component="tag"\` with size data attributes.

`,l=u({title:"UI/Tag",mod:y,args:{children:"Tag"}}),_={title:"UI/Tag",id:"components-tag",component:l.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:f}}},argTypes:{size:{control:"select",options:["normal","large"]}}},e=l.Basic,s={render:()=>(()=>{var a=v();return o(a,i(n,{size:"normal",children:"Normal"}),null),o(a,i(n,{size:"large",children:"Large"}),null),a})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  47 | }
  48 |
> 49 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  50 |
  51 | export const Sizes = {
  52 |   render: () => (`,...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
    <mod.Tag size="normal">Normal</mod.Tag>
    <mod.Tag size="large">Large</mod.Tag>
  </div>
);
`,...s.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "8px",
    "align-items": "center"
  }}>
      <mod.Tag size="normal">Normal</mod.Tag>
      <mod.Tag size="large">Large</mod.Tag>
    </div>
}`,...s.parameters?.docs?.source}}};const h=["Basic","Sizes"];export{e as Basic,s as Sizes,h as __namedExportsOrder,_ as default};
