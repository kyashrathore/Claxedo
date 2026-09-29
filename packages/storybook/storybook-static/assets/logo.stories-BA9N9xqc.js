import{K as l,t as n,W as d,ad as v,i,b as r}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var c=n('<svg data-component=logo-mark viewBox="0 0 16 20"fill=none xmlns=http://www.w3.org/2000/svg><path data-slot=logo-logo-mark-shadow d="M12 16H4V8H12V16Z"fill=var(--icon-weak-base)></path><path data-slot=logo-logo-mark-o d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z"fill=var(--icon-strong-base)>'),h=n('<svg data-component=logo-splash viewBox="0 0 80 100"fill=none xmlns=http://www.w3.org/2000/svg><path d="M60 80H20V40H60V80Z"fill=var(--icon-base)></path><path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z"fill=var(--icon-strong-base)>'),V=n('<svg xmlns=http://www.w3.org/2000/svg viewBox="0 0 234 42"fill=none><g><path d="M18 30H6V18H18V30Z"fill=var(--icon-weak-base)></path><path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z"fill=var(--icon-base)></path><path d="M48 30H36V18H48V30Z"fill=var(--icon-weak-base)></path><path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z"fill=var(--icon-base)></path><path d="M84 24V30H66V24H84Z"fill=var(--icon-weak-base)></path><path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z"fill=var(--icon-base)></path><path d="M108 36H96V18H108V36Z"fill=var(--icon-weak-base)></path><path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z"fill=var(--icon-base)></path><path d="M144 30H126V18H144V30Z"fill=var(--icon-weak-base)></path><path d="M144 12H126V30H144V36H120V6H144V12Z"fill=var(--icon-strong-base)></path><path d="M168 30H156V18H168V30Z"fill=var(--icon-weak-base)></path><path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z"fill=var(--icon-strong-base)></path><path d="M198 30H186V18H198V30Z"fill=var(--icon-weak-base)></path><path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z"fill=var(--icon-strong-base)></path><path d="M234 24V30H216V24H234Z"fill=var(--icon-weak-base)></path><path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z"fill=var(--icon-strong-base)>');const H=t=>(()=>{var a=c();return l(e=>d(a,{[t.class??""]:!!t.class},e)),a})(),g=t=>(()=>{var a=h(),e=t.ref;return typeof e=="function"?v(e,a):t.ref=a,l(s=>d(a,{[t.class??""]:!!t.class},s)),a})(),p=t=>(()=>{var a=V();return l(e=>d(a,{[t.class??""]:!!t.class},e)),a})();var f=n("<div style=display:grid;gap:16px;align-items:start><div><div style=color:var(--text-weak);font-size:12px>Mark</div></div><div><div style=color:var(--text-weak);font-size:12px>Splash</div></div><div><div style=color:var(--text-weak);font-size:12px>Logo");const m=`### Overview
OpenCode logo assets: mark, splash, and wordmark.

Use Mark for compact spaces, Logo for headers, Splash for hero sections.

### API
- \`Mark\`, \`Splash\`, and \`Logo\` components accept standard SVG props.

### Variants and states
- Multiple logo variants for different contexts.

### Behavior
- Pure SVG rendering.

### Accessibility
- Provide title/aria-label when logos convey meaning.

### Theming/tokens
- Uses theme color tokens via CSS variables.

`,M={title:"UI/Logo",id:"components-logo",component:p,tags:["autodocs"],parameters:{docs:{description:{component:m}}}},o={render:()=>(()=>{var t=f(),a=t.firstChild;a.firstChild;var e=a.nextSibling;e.firstChild;var s=e.nextSibling;return s.firstChild,i(a,r(H,{}),null),i(e,r(g,{style:{width:"80px",height:"100px"}}),null),i(s,r(p,{style:{width:"200px"}}),null),t})()};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Basic = () => (
  <div style={{ display: "grid", gap: "16px", "align-items": "start" }}>
    <div>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Mark</div>
      <mod.Mark />
    </div>
    <div>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Splash
      </div>
      <mod.Splash style={{ width: "80px", height: "100px" }} />
    </div>
    <div>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Logo</div>
      <mod.Logo style={{ width: "200px" }} />
    </div>
  </div>
);
`,...o.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "16px",
    "align-items": "start"
  }}>
      <div>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Mark</div>
        <mod.Mark />
      </div>
      <div>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Splash</div>
        <mod.Splash style={{
        width: "80px",
        height: "100px"
      }} />
      </div>
      <div>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Logo</div>
        <mod.Logo style={{
        width: "200px"
      }} />
      </div>
    </div>
}`,...o.parameters?.docs?.source}}};const k=["Basic"];export{o as Basic,k as __namedExportsOrder,M as default};
