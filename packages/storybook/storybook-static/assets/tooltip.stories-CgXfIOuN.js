import{b as a,t as n}from"./iframe-D288tw9h.js";import{m as c,T as i}from"./tooltip-3OGsQ03U.js";import{c as p}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";var d=n("<span style=text-decoration:underline>Hover for keybind");const m=`### Overview
Tooltip for contextual hints and keybind callouts.

Use for short hints; avoid long descriptions.

### API
- Required: \`value\` (tooltip content).
- Optional: \`inactive\`, \`forceOpen\`, placement props from Kobalte.

### Variants and states
- Supports keybind-style tooltip via \`TooltipKeybind\`.

### Behavior
- Opens on hover/focus; can be forced open.

### Accessibility
- TODO: confirm trigger semantics and focus behavior.

### Theming/tokens
- Uses \`data-component="tooltip"\` and related slots.

`,s=p({title:"UI/Tooltip",mod:c,args:{value:"Tooltip",children:"Hover me"}}),K={title:"UI/Tooltip",id:"components-tooltip",component:s.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:m}}}},e=s.Basic,o={render:()=>a(i,{title:"Search",keybind:"Cmd+K",get children(){return d()}})},r={args:{forceOpen:!0}},t={args:{inactive:!0}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  42 | }
  43 |
> 44 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  45 |
  46 | export const Keybind = {
  47 |   render: () => (`,...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Keybind = () => (
  <mod.TooltipKeybind title="Search" keybind="Cmd+K">
    <span style={{ "text-decoration": "underline" }}>Hover for keybind</span>
  </mod.TooltipKeybind>
);
`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const ForcedOpen = () => <story.meta.component forceOpen />;
`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Inactive = () => <story.meta.component inactive />;
`,...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <mod.TooltipKeybind title="Search" keybind="Cmd+K">
      <span style={{
      "text-decoration": "underline"
    }}>Hover for keybind</span>
    </mod.TooltipKeybind>
}`,...o.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    forceOpen: true
  }
}`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    inactive: true
  }
}`,...t.parameters?.docs?.source}}};const O=["Basic","Keybind","ForcedOpen","Inactive"];export{e as Basic,r as ForcedOpen,t as Inactive,o as Keybind,O as __namedExportsOrder,K as default};
