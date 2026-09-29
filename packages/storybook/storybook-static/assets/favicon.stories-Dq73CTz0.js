import{b as a,aB as n,aC as s,i as r,t as c}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";const t=()=>[a(n,{rel:"icon",type:"image/png",href:"/favicon-96x96-v3.png",sizes:"96x96"}),a(n,{rel:"shortcut icon",href:"/favicon-v3.ico"}),a(n,{rel:"apple-touch-icon",sizes:"180x180",href:"/apple-touch-icon-v3.png"}),a(n,{rel:"manifest",href:"/site.webmanifest"}),a(s,{name:"apple-mobile-web-app-title",content:"OpenCode"})];var p=c("<div style=display:grid;gap:8px><div style=color:var(--text-weak);font-size:12px>Head tags are injected for favicon and app icons.");const d=`### Overview
Injects favicon and app icon meta tags for the document head.

Render once near the app root (head management).

### API
- No props.

### Variants and states
- Single configuration.

### Behavior
- Registers link and meta tags via Solid Meta components.

### Accessibility
- Not applicable.

### Theming/tokens
- Not applicable.

`,m={title:"UI/Favicon",id:"components-favicon",component:t,tags:["autodocs"],parameters:{docs:{description:{component:d}}}},e={render:()=>(()=>{var o=p(),i=o.firstChild;return r(o,a(t,{}),i),o})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => (
  <div style={{ display: "grid", gap: "8px" }}>
    <mod.Favicon />
    <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
      Head tags are injected for favicon and app icons.
    </div>
  </div>
);
`,...e.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "8px"
  }}>
      <mod.Favicon />
      <div style={{
      color: "var(--text-weak)",
      "font-size": "12px"
    }}>
        Head tags are injected for favicon and app icons.
      </div>
    </div>
}`,...e.parameters?.docs?.source}}};const f=["Basic"];export{e as Basic,f as __namedExportsOrder,m as default};
