import{i,t as a,b as p}from"./iframe-D288tw9h.js";import{i as d,m as l,P as m}from"./provider-icon-Bc6edC8j.js";import{c as v}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./inline-svg-sprite-SZycwMcv.js";var g=a('<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill, minmax(80px, 1fr))">'),x=a("<div style=display:grid;gap:6px;justify-items:center><div style=font-size:10px;color:var(--text-weak);text-align:center>");const y=`### Overview
Provider icon sprite renderer for model/provider badges.

Use in model pickers or provider lists.

### API
- Required: \`id\` (provider icon name).
- Accepts standard SVG props.

### Variants and states
- Single visual style; size via CSS.

### Behavior
- Renders from the provider SVG sprite sheet.

### Accessibility
- Provide accessible text nearby when the icon conveys meaning.

### Theming/tokens
- Uses \`data-component="provider-icon"\`.

`,c=v({title:"UI/ProviderIcon",mod:l,args:{id:"openai"}}),P={title:"UI/ProviderIcon",id:"components-provider-icon",component:c.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:y}}},argTypes:{id:{control:"select",options:d}}},e=c.Basic,r={render:()=>(()=>{var n=g();return i(n,()=>d.map(t=>(()=>{var s=x(),o=s.firstChild;return i(s,p(m,{id:t,width:"28",height:"28","aria-label":t}),o),i(o,t),s})())),n})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  48 | }
  49 |
> 50 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  51 |
  52 | export const AllIcons = {
  53 |   render: () => (`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const AllIcons = () => (
  <div
    style={{
      display: "grid",
      gap: "12px",
      "grid-template-columns": "repeat(auto-fill, minmax(80px, 1fr))",
    }}
  >
    {iconNames.map((id) => (
      <div style={{ display: "grid", gap: "6px", "justify-items": "center" }}>
        <mod.ProviderIcon id={id} width="28" height="28" aria-label={id} />
        <div
          style={{
            "font-size": "10px",
            color: "var(--text-weak)",
            "text-align": "center",
          }}
        >
          {id}
        </div>
      </div>
    ))}
  </div>
);
`,...r.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px",
    "grid-template-columns": "repeat(auto-fill, minmax(80px, 1fr))"
  }}>
      {iconNames.map(id => <div style={{
      display: "grid",
      gap: "6px",
      "justify-items": "center"
    }}>
          <mod.ProviderIcon id={id} width="28" height="28" aria-label={id} />
          <div style={{
        "font-size": "10px",
        color: "var(--text-weak)",
        "text-align": "center"
      }}>{id}</div>
        </div>)}
    </div>
}`,...r.parameters?.docs?.source}}};const w=["Basic","AllIcons"];export{r as AllIcons,e as Basic,w as __namedExportsOrder,P as default};
