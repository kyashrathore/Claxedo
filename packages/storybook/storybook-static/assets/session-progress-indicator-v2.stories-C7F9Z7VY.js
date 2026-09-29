import{b as a,i as t,t as i}from"./iframe-D288tw9h.js";import{S as n}from"./session-progress-indicator-v2-D2yDABQ0.js";import"./preload-helper-D9Z9MdNV.js";var c=i("<div style=display:flex;gap:16px;align-items:center>"),d=i("<div style=display:flex;gap:16px;align-items:center;padding:16px;background-color:#171717;color:#c7c7c7>");const p=`### Overview
Animated 5×5 dot grid loader for in-progress session state.

Derived from Figma \`_sessionProgressIndicator\` with 8-frame rotation.

### API
- Accepts standard SVG props.

### Behavior
- CSS keyframes drive per-dot opacity across 8 frames (1.2s loop).
- Center dot stays at full opacity throughout the cycle.

### Accessibility
- Sets \`aria-hidden="true"\` by default.

### Theming
- Uses \`currentColor\` via \`--v2-icon-icon-muted\`.
`,u={title:"UI V2/SessionProgressIndicator",id:"components-session-progress-indicator-v2",component:n,tags:["autodocs"],parameters:{docs:{description:{component:p}}}},e={render:()=>a(n,{})},r={render:()=>(()=>{var o=c();return t(o,a(n,{width:12,height:12}),null),t(o,a(n,{}),null),t(o,a(n,{width:24,height:24}),null),o})()},s={render:()=>(()=>{var o=d();return t(o,a(n,{})),o})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => <SessionProgressIndicatorV2 />;
`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <SessionProgressIndicatorV2 width={12} height={12} />
    <SessionProgressIndicatorV2 />
    <SessionProgressIndicatorV2 width={24} height={24} />
  </div>
);
`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const OnDark = () => (
  <div
    style={{
      display: "flex",
      gap: "16px",
      "align-items": "center",
      padding: "16px",
      "background-color": "#171717",
      color: "#c7c7c7",
    }}
  >
    <SessionProgressIndicatorV2 />
  </div>
);
`,...s.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <SessionProgressIndicatorV2 />
}`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <SessionProgressIndicatorV2 width={12} height={12} />
      <SessionProgressIndicatorV2 />
      <SessionProgressIndicatorV2 width={24} height={24} />
    </div>
}`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center",
    padding: "16px",
    "background-color": "#171717",
    color: "#c7c7c7"
  }}>
      <SessionProgressIndicatorV2 />
    </div>
}`,...s.parameters?.docs?.source}}};const h=["Basic","Sizes","OnDark"];export{e as Basic,s as OnDark,r as Sizes,h as __namedExportsOrder,u as default};
