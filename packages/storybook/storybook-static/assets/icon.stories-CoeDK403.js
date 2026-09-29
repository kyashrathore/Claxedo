import{i as r,b as t,t as c}from"./iframe-D288tw9h.js";import{o as u,m as g,I as o,O as y}from"./icon-BG5j3Qjr.js";import{c as x}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var v=c("<div style=display:flex;gap:12px;align-items:center>"),f=c('<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill, minmax(88px, 1fr))">'),h=c("<div style=display:grid;gap:6px;justify-items:center><div style=font-size:10px;color:var(--text-weak);text-align:center>");const z=`### Overview
Inline icon renderer using the built-in OpenCode icon set.

Use with \`Button\`, \`IconButton\`, and menu items.

### API
- Required: \`name\` (icon key).
- Optional: \`size\` (small | normal | medium | large).
- Accepts standard SVG props.

### Variants and states
- Size variants only.

### Behavior
- Uses an internal SVG path map.

### Accessibility
- Icons are aria-hidden by default; wrap with accessible text when needed.

### Theming/tokens
- Uses \`data-component="icon"\` with size data attributes.

`,l=u,p=x({title:"UI/Icon",mod:g,args:{name:"check"}}),b={title:"UI/Icon",id:"components-icon",component:p.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:z}}},argTypes:{name:{control:"select",options:l},size:{control:"select",options:["small","normal","medium","large"]}}},n=p.Basic,a={render:()=>(()=>{var e=v();return r(e,t(o,{name:"check",size:"small"}),null),r(e,t(o,{name:"check",size:"normal"}),null),r(e,t(o,{name:"check",size:"medium"}),null),r(e,t(o,{name:"check",size:"large"}),null),e})()},s={render:()=>(()=>{var e=f();return r(e,()=>l.map(m=>(()=>{var i=h(),d=i.firstChild;return r(i,t(y,{name:m}),d),r(d,m),i})())),e})()};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  55 | }
  56 |
> 57 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  58 |
  59 | export const Sizes = {
  60 |   render: () => (`,...n.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <mod.Icon name="check" size="small" />
    <mod.Icon name="check" size="normal" />
    <mod.Icon name="check" size="medium" />
    <mod.Icon name="check" size="large" />
  </div>
);
`,...a.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Gallery = () => (
  <div
    style={{
      display: "grid",
      gap: "12px",
      "grid-template-columns": "repeat(auto-fill, minmax(88px, 1fr))",
    }}
  >
    {names.map((name) => (
      <div style={{ display: "grid", gap: "6px", "justify-items": "center" }}>
        <mod.OpenCodeIcon name={name} />
        <div
          style={{
            "font-size": "10px",
            color: "var(--text-weak)",
            "text-align": "center",
          }}
        >
          {name}
        </div>
      </div>
    ))}
  </div>
);
`,...s.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:"story.Basic",...n.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <mod.Icon name="check" size="small" />
      <mod.Icon name="check" size="normal" />
      <mod.Icon name="check" size="medium" />
      <mod.Icon name="check" size="large" />
    </div>
}`,...a.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px",
    "grid-template-columns": "repeat(auto-fill, minmax(88px, 1fr))"
  }}>
      {names.map(name => <div style={{
      display: "grid",
      gap: "6px",
      "justify-items": "center"
    }}>
          <mod.OpenCodeIcon name={name} />
          <div style={{
        "font-size": "10px",
        color: "var(--text-weak)",
        "text-align": "center"
      }}>{name}</div>
        </div>)}
    </div>
}`,...s.parameters?.docs?.source}}};const O=["Basic","Sizes","Gallery"];export{n as Basic,s as Gallery,a as Sizes,O as __namedExportsOrder,b as default};
