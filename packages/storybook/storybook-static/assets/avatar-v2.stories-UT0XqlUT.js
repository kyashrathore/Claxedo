import{i as l,b as o,t as c}from"./iframe-D288tw9h.js";import{A as t}from"./avatar-v2-OOiGnRRK.js";import"./preload-helper-D9Z9MdNV.js";var i=c("<div style=display:flex;gap:12px;align-items:center>");const d=`### Overview
Avatar matching OpenCode DS variants from Figma.

Use in user lists and headers.

### API
- Required: \`fallback\` string.
- Optional: \`src\`, \`background\`, \`foreground\`, \`size\`, \`kind\`.

### Variants and states
- Sizes: small (16), normal (20), large (28).
- Kind: user (circle), org (rounded-square).
- Image vs initials content state.

### Behavior
- Uses grapheme-aware fallback rendering.

### Accessibility
- TODO: provide alt text when using images; currently image is decorative.

### Theming/tokens
- Uses \`data-component="avatar"\` with size and image state attributes.

`,u={title:"UI V2/Avatar",id:"components-avatar-v2",component:t,tags:["autodocs"],parameters:{docs:{description:{component:d}}},argTypes:{size:{control:"select",options:["small","normal","large"]},kind:{control:"select",options:["user","org"]}},args:{fallback:"WW",size:"large",kind:"user"}},e={},r={args:{src:"https://placehold.co/80x80/png",fallback:"WW"}},s={render:()=>(()=>{var a=i();return l(a,o(t,{size:"small",fallback:"W"}),null),l(a,o(t,{size:"normal",fallback:"W"}),null),l(a,o(t,{size:"large",fallback:"WW"}),null),a})()},n={render:()=>(()=>{var a=i();return l(a,o(t,{kind:"org",size:"small",fallback:"W"}),null),l(a,o(t,{kind:"org",size:"normal",fallback:"W"}),null),l(a,o(t,{kind:"org",size:"large",fallback:"WW"}),null),a})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => <Avatar fallback="WW" size="large" kind="user" />;
`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const WithImage = () => (
  <Avatar
    fallback="WW"
    size="large"
    kind="user"
    src="https://placehold.co/80x80/png"
  />
);
`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <Avatar size="small" fallback="W" />
    <Avatar size="normal" fallback="W" />
    <Avatar size="large" fallback="WW" />
  </div>
);
`,...s.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const OrgVariant = () => (
  <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
    <Avatar kind="org" size="small" fallback="W" />
    <Avatar kind="org" size="normal" fallback="W" />
    <Avatar kind="org" size="large" fallback="WW" />
  </div>
);
`,...n.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"{}",...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    src: "https://placehold.co/80x80/png",
    fallback: "WW"
  }
}`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <Avatar size="small" fallback="W" />
      <Avatar size="normal" fallback="W" />
      <Avatar size="large" fallback="WW" />
    </div>
}`,...s.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center"
  }}>
      <Avatar kind="org" size="small" fallback="W" />
      <Avatar kind="org" size="normal" fallback="W" />
      <Avatar kind="org" size="large" fallback="WW" />
    </div>
}`,...n.parameters?.docs?.source}}};const k=["Basic","WithImage","Sizes","OrgVariant"];export{e as Basic,n as OrgVariant,s as Sizes,r as WithImage,k as __namedExportsOrder,u as default};
