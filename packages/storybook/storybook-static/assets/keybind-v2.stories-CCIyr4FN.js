import{i as a,b as r,t as p}from"./iframe-D288tw9h.js";import{K as e}from"./keybind-v2-CYIWlVFo.js";import"./preload-helper-D9Z9MdNV.js";var y=p("<div style=display:flex;gap:24px;align-items:center>"),c=p("<div style=display:flex;flex-direction:column;gap:16px><div style=display:flex;gap:24px;align-items:center><span style=font-size:11px;color:#808080;width:50px>Neutral</span></div><div style=display:flex;gap:24px;align-items:center><span style=font-size:11px;color:#808080;width:50px>Ghost");const u=`### Overview
Inline keybind indicator that renders one or more keyboard keys in a compact row.

### API
- \`keys\`: Array of key labels to display (e.g. \`["⌘", "K"]\`).
- \`variant\`: "neutral" (gray background) | "ghost" (no background).
- Inherits native div attributes.

### Variants
- **Neutral** — each key sits on a \`#D4D4D4\` pill with darker text.
- **Ghost** — keys render without a background, lighter text color.
`,x={title:"UI V2/Keybind",id:"components-keybind-v2",component:e,tags:["autodocs"],parameters:{frameHeight:"200px",frameBackground:"#fff",docs:{description:{component:u}}},args:{keys:["⌘"],variant:"neutral"},argTypes:{keys:{control:"object"},variant:{control:"select",options:["neutral","ghost"]}}},s={},t={render:()=>(()=>{var n=y();return a(n,r(e,{keys:["⌘"],variant:"neutral"}),null),a(n,r(e,{keys:["⌘"],variant:"ghost"}),null),n})()},i={render:()=>(()=>{var n=y();return a(n,r(e,{keys:["⌘","K"],variant:"neutral"}),null),a(n,r(e,{keys:["⌘","K"],variant:"ghost"}),null),n})()},l={render:()=>(()=>{var n=c(),o=n.firstChild;o.firstChild;var d=o.nextSibling;return d.firstChild,a(o,r(e,{keys:["⌘"],variant:"neutral"}),null),a(o,r(e,{keys:["⌘","K"],variant:"neutral"}),null),a(o,r(e,{keys:["⌘","⇧","P"],variant:"neutral"}),null),a(d,r(e,{keys:["⌘"],variant:"ghost"}),null),a(d,r(e,{keys:["⌘","K"],variant:"ghost"}),null),a(d,r(e,{keys:["⌘","⇧","P"],variant:"ghost"}),null),n})()};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Playground = () => <KeybindV2 keys={["⌘"]} variant="neutral" />;
`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Variants = () => (
  <div style={{ display: "flex", gap: "24px", "align-items": "center" }}>
    <KeybindV2 keys={["⌘"]} variant="neutral" />
    <KeybindV2 keys={["⌘"]} variant="ghost" />
  </div>
);
`,...t.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const MultipleKeys = () => (
  <div style={{ display: "flex", gap: "24px", "align-items": "center" }}>
    <KeybindV2 keys={["⌘", "K"]} variant="neutral" />
    <KeybindV2 keys={["⌘", "K"]} variant="ghost" />
  </div>
);
`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const AllExamples = () => (
  <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
    <div style={{ display: "flex", gap: "24px", "align-items": "center" }}>
      <span style={{ "font-size": "11px", color: "#808080", width: "50px" }}>
        Neutral
      </span>
      <KeybindV2 keys={["⌘"]} variant="neutral" />
      <KeybindV2 keys={["⌘", "K"]} variant="neutral" />
      <KeybindV2 keys={["⌘", "⇧", "P"]} variant="neutral" />
    </div>
    <div style={{ display: "flex", gap: "24px", "align-items": "center" }}>
      <span style={{ "font-size": "11px", color: "#808080", width: "50px" }}>
        Ghost
      </span>
      <KeybindV2 keys={["⌘"]} variant="ghost" />
      <KeybindV2 keys={["⌘", "K"]} variant="ghost" />
      <KeybindV2 keys={["⌘", "⇧", "P"]} variant="ghost" />
    </div>
  </div>
);
`,...l.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:"{}",...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "24px",
    "align-items": "center"
  }}>
      <KeybindV2 keys={["⌘"]} variant="neutral" />
      <KeybindV2 keys={["⌘"]} variant="ghost" />
    </div>
}`,...t.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "24px",
    "align-items": "center"
  }}>
      <KeybindV2 keys={["⌘", "K"]} variant="neutral" />
      <KeybindV2 keys={["⌘", "K"]} variant="ghost" />
    </div>
}`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    "flex-direction": "column",
    gap: "16px"
  }}>
      <div style={{
      display: "flex",
      gap: "24px",
      "align-items": "center"
    }}>
        <span style={{
        "font-size": "11px",
        color: "#808080",
        width: "50px"
      }}>Neutral</span>
        <KeybindV2 keys={["⌘"]} variant="neutral" />
        <KeybindV2 keys={["⌘", "K"]} variant="neutral" />
        <KeybindV2 keys={["⌘", "⇧", "P"]} variant="neutral" />
      </div>
      <div style={{
      display: "flex",
      gap: "24px",
      "align-items": "center"
    }}>
        <span style={{
        "font-size": "11px",
        color: "#808080",
        width: "50px"
      }}>Ghost</span>
        <KeybindV2 keys={["⌘"]} variant="ghost" />
        <KeybindV2 keys={["⌘", "K"]} variant="ghost" />
        <KeybindV2 keys={["⌘", "⇧", "P"]} variant="ghost" />
      </div>
    </div>
}`,...l.parameters?.docs?.source}}};const k=["Playground","Variants","MultipleKeys","AllExamples"];export{l as AllExamples,i as MultipleKeys,s as Playground,t as Variants,k as __namedExportsOrder,x as default};
