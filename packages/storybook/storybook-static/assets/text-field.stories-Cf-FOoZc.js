import{i,b as c,t as u}from"./iframe-D288tw9h.js";import{m as b,T as p}from"./text-field-aUCYYfm_.js";import{c as y}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";import"./i18n-CW9P7x91.js";import"./icon-button-C_HG_auw.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./tooltip-3OGsQ03U.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";var h=u("<div style=display:grid;gap:12px;width:320px>");const g='### Overview\nText input with label, description, and optional copy-to-clipboard action.\n\nPair with `Tooltip` and `IconButton` for copy affordance (built in).\n\n### API\n- Supports Kobalte TextField props: `value`, `defaultValue`, `onChange`, `disabled`, `readOnly`.\n- Optional: `label`, `description`, `error`, `variant`, `copyable`, `multiline`.\n\n### Variants and states\n- Normal and ghost variants.\n- Supports multiline textarea.\n\n### Behavior\n- When `copyable` is true, clicking copies the current value.\n\n### Accessibility\n- Label is hidden when `hideLabel` is true (sr-only).\n\n### Theming/tokens\n- Uses `data-component="input"` with slot attributes for styling.\n\n',m=y({title:"UI/TextField",mod:b,args:{label:"Label",placeholder:"Type here...",defaultValue:"Hello"}}),B={title:"UI/TextField",id:"components-text-field",component:m.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:g}}}},e=m.Basic,a={render:()=>(()=>{var d=h();return i(d,c(p,{label:"Normal",placeholder:"Type here...",defaultValue:"Value"}),null),i(d,c(p,{label:"Ghost",variant:"ghost",placeholder:"Type here...",defaultValue:"Value"}),null),d})()},r={args:{label:"Description",multiline:!0,defaultValue:`Line one
Line two`}},t={args:{label:"Invite link",defaultValue:"https://example.com/invite/abc",copyable:!0,copyKind:"link"}},o={args:{label:"Email",defaultValue:"invalid@",error:"Enter a valid email address"}},n={args:{label:"Disabled",defaultValue:"Readonly",disabled:!0}},s={args:{label:"Read only",defaultValue:"Read only value",readOnly:!0}},l={args:{label:"Hidden label",hideLabel:!0,placeholder:"Hidden label"}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  51 | }
  52 |
> 53 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  54 |
  55 | export const Variants = {
  56 |   render: () => (`,...e.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Variants = () => (
  <div style={{ display: "grid", gap: "12px", width: "320px" }}>
    <mod.TextField
      label="Normal"
      placeholder="Type here..."
      defaultValue="Value"
    />
    <mod.TextField
      label="Ghost"
      variant="ghost"
      placeholder="Type here..."
      defaultValue="Value"
    />
  </div>
);
`,...a.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Multiline = () => (
  <story.meta.component
    label="Description"
    multiline
    defaultValue="Line one\\nLine two"
  />
);
`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Copyable = () => (
  <story.meta.component
    label="Invite link"
    defaultValue="https://example.com/invite/abc"
    copyable
    copyKind="link"
  />
);
`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Error = () => (
  <story.meta.component
    label="Email"
    defaultValue="invalid@"
    error="Enter a valid email address"
  />
);
`,...o.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Disabled = () => (
  <story.meta.component label="Disabled" defaultValue="Readonly" disabled />
);
`,...n.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const ReadOnly = () => (
  <story.meta.component
    label="Read only"
    defaultValue="Read only value"
    readOnly
  />
);
`,...s.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const HiddenLabel = () => (
  <story.meta.component
    label="Hidden label"
    hideLabel
    placeholder="Hidden label"
  />
);
`,...l.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px",
    width: "320px"
  }}>
      <mod.TextField label="Normal" placeholder="Type here..." defaultValue="Value" />
      <mod.TextField label="Ghost" variant="ghost" placeholder="Type here..." defaultValue="Value" />
    </div>
}`,...a.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Description",
    multiline: true,
    defaultValue: "Line one\\nLine two"
  }
}`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Invite link",
    defaultValue: "https://example.com/invite/abc",
    copyable: true,
    copyKind: "link"
  }
}`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Email",
    defaultValue: "invalid@",
    error: "Enter a valid email address"
  }
}`,...o.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Disabled",
    defaultValue: "Readonly",
    disabled: true
  }
}`,...n.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Read only",
    defaultValue: "Read only value",
    readOnly: true
  }
}`,...s.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  args: {
    label: "Hidden label",
    hideLabel: true,
    placeholder: "Hidden label"
  }
}`,...l.parameters?.docs?.source}}};const I=["Basic","Variants","Multiline","Copyable","Error","Disabled","ReadOnly","HiddenLabel"];export{e as Basic,t as Copyable,n as Disabled,o as Error,l as HiddenLabel,r as Multiline,s as ReadOnly,a as Variants,I as __namedExportsOrder,B as default};
