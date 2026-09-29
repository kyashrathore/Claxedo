import{F as t,i as a,b as s,t as i}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var r=i("<div style=display:grid;gap:8px><div style=font-family:var(--font-family-sans)>OpenCode Sans Sample</div><div style=font-family:var(--font-family-mono)>OpenCode Mono Sample");const p=`### Overview
Uses native system font stacks for sans and mono typography.

Optional compatibility component. Existing roots can keep rendering it, but it does nothing.

### API
- No props.

### Variants and states
- No variants.

### Behavior
- Compatibility wrapper only. No font assets are injected or preloaded.

### Accessibility
- Not applicable.

### Theming/tokens
- Theme tokens come from CSS variables, not this component.

`,l={title:"UI/Font",id:"components-font",component:t,tags:["autodocs"],parameters:{docs:{description:{component:p}}}},n={render:()=>(()=>{var o=r(),e=o.firstChild;return e.nextSibling,a(o,s(t,{}),e),o})()};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Basic = () => (
  <div style={{ display: "grid", gap: "8px" }}>
    <mod.Font />
    <div style={{ "font-family": "var(--font-family-sans)" }}>
      OpenCode Sans Sample
    </div>
    <div style={{ "font-family": "var(--font-family-mono)" }}>
      OpenCode Mono Sample
    </div>
  </div>
);
`,...n.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "8px"
  }}>
      <mod.Font />
      <div style={{
      "font-family": "var(--font-family-sans)"
    }}>OpenCode Sans Sample</div>
      <div style={{
      "font-family": "var(--font-family-mono)"
    }}>OpenCode Mono Sample</div>
    </div>
}`,...n.parameters?.docs?.source}}};const c=["Basic"];export{n as Basic,c as __namedExportsOrder,l as default};
