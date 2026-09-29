import{i,b as s,t as a}from"./iframe-D288tw9h.js";import{T as p}from"./tooltip-v2-ejrje0OW.js";import{K as d}from"./keybind-v2-CYIWlVFo.js";import"./preload-helper-D9Z9MdNV.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";var l=a("<span>Hover me"),c=a("<div style=padding:80px;display:flex;justify-content:center>"),m=a("<span style=color:var(--text-text-faint)>/"),v=a("<span>Title"),u=a("<span style=color:var(--text-text-faint)>·"),y=a("<span style=color:var(--text-text-faint)>Description");const x=`### Overview
Floating tooltip built on Kobalte's tooltip primitive with v2 styling.

### API
- \`value\`: Content rendered inside the floating tooltip.
- \`children\`: The trigger element that activates the tooltip on hover/focus.
- \`placement\`: Kobalte placement string (e.g. "top", "bottom", "left", "right").
- \`inactive\`: When true, renders only the trigger without tooltip behavior.
- \`forceOpen\`: Forces the tooltip to stay open.
- Inherits Kobalte Tooltip root props.
`,H={title:"UI V2/Tooltip",id:"components-tooltip-v2",component:p,tags:["autodocs"],parameters:{frameHeight:"300px",frameBackground:"#fff",docs:{description:{component:x}}}},t={render:()=>(()=>{var e=c();return i(e,s(p,{value:"Tooltip Text",get children(){return l()}})),e})()},n={render:()=>(()=>{var e=c();return i(e,s(p,{get value(){return["Tooltip Text",s(d,{keys:["⌘","⌘"],variant:"neutral"})]},get children(){return l()}})),e})()},o={render:()=>(()=>{var e=c();return i(e,s(p,{get value(){return["Components ",m()," Tooltip"]},get children(){return l()}})),e})()},r={render:()=>(()=>{var e=c();return i(e,s(p,{get value(){return[v(),u(),y()]},get children(){return l()}})),e})()};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Simple = () => (
  <div
    style={{ padding: "80px", display: "flex", "justify-content": "center" }}
  >
    <TooltipV2 value="Tooltip Text">
      <span>Hover me</span>
    </TooltipV2>
  </div>
);
`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const WithKeybind = () => (
  <div
    style={{ padding: "80px", display: "flex", "justify-content": "center" }}
  >
    <TooltipV2
      value={
        <>
          Tooltip Text
          <KeybindV2 keys={["⌘", "⌘"]} variant="neutral" />
        </>
      }
    >
      <span>Hover me</span>
    </TooltipV2>
  </div>
);
`,...n.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Path = () => (
  <div
    style={{ padding: "80px", display: "flex", "justify-content": "center" }}
  >
    <TooltipV2
      value={
        <>
          Components <span style={{ color: "var(--text-text-faint)" }}>/</span>{" "}
          Tooltip
        </>
      }
    >
      <span>Hover me</span>
    </TooltipV2>
  </div>
);
`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const TitleDescription = () => (
  <div
    style={{ padding: "80px", display: "flex", "justify-content": "center" }}
  >
    <TooltipV2
      value={
        <>
          <span>Title</span>
          <span style={{ color: "var(--text-text-faint)" }}>·</span>
          <span style={{ color: "var(--text-text-faint)" }}>Description</span>
        </>
      }
    >
      <span>Hover me</span>
    </TooltipV2>
  </div>
);
`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    padding: "80px",
    display: "flex",
    "justify-content": "center"
  }}>
      <TooltipV2 value="Tooltip Text">
        <span>Hover me</span>
      </TooltipV2>
    </div>
}`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    padding: "80px",
    display: "flex",
    "justify-content": "center"
  }}>
      <TooltipV2 value={<>
            Tooltip Text
            <KeybindV2 keys={["⌘", "⌘"]} variant="neutral" />
          </>}>
        <span>Hover me</span>
      </TooltipV2>
    </div>
}`,...n.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    padding: "80px",
    display: "flex",
    "justify-content": "center"
  }}>
      <TooltipV2 value={<>
            Components <span style={{
        color: "var(--text-text-faint)"
      }}>/</span> Tooltip
          </>}>
        <span>Hover me</span>
      </TooltipV2>
    </div>
}`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    padding: "80px",
    display: "flex",
    "justify-content": "center"
  }}>
      <TooltipV2 value={<>
            <span>Title</span>
            <span style={{
        color: "var(--text-text-faint)"
      }}>·</span>
            <span style={{
        color: "var(--text-text-faint)"
      }}>Description</span>
          </>}>
        <span>Hover me</span>
      </TooltipV2>
    </div>
}`,...r.parameters?.docs?.source}}};const K=["Simple","WithKeybind","Path","TitleDescription"];export{o as Path,t as Simple,r as TitleDescription,n as WithKeybind,K as __namedExportsOrder,H as default};
