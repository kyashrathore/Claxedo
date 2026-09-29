import{b as o,m as r,i,t as n}from"./iframe-D288tw9h.js";import{C as e}from"./collapsible-Du8zhFL1.js";import"./preload-helper-D9Z9MdNV.js";import"./UGE6PPGT-C6B63Gso.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var p=n("<div style=display:flex;align-items:center;gap:8px><span>Details"),d=n("<div style=color:var(--text-weak);padding-top:8px>Optional details sit here."),c=n("<div style=display:flex;align-items:center;gap:8px><span>Ghost trigger"),g=n("<div style=color:var(--text-weak);padding-top:8px>Ghost content.");const m=`### Overview
Toggleable content region with optional arrow indicator.

Compose \`Collapsible.Trigger\`, \`Collapsible.Content\`, and \`Collapsible.Arrow\`.

### API
- Root accepts Kobalte Collapsible props (\`open\`, \`defaultOpen\`, \`onOpenChange\`).
- \`variant\` controls styling ("normal" | "ghost").

### Variants and states
- Normal and ghost variants.
- Open/closed states.

### Behavior
- Trigger toggles the content visibility.

### Accessibility
- TODO: confirm ARIA attributes provided by Kobalte.

### Theming/tokens
- Uses \`data-component="collapsible"\` and slots for trigger/content/arrow.

`,f={title:"UI/Collapsible",id:"components-collapsible",component:e,tags:["autodocs"],parameters:{docs:{description:{component:m}}},argTypes:{variant:{control:"select",options:["normal","ghost"]}}},t={args:{variant:"normal",defaultOpen:!0},render:s=>o(e,r(s,{get children(){return[o(e.Trigger,{"data-slot":"collapsible-trigger",get children(){var a=p();return a.firstChild,i(a,o(e.Arrow,{}),null),a}}),o(e.Content,{"data-slot":"collapsible-content",get children(){return d()}})]}}))},l={args:{variant:"ghost",defaultOpen:!1},render:s=>o(e,r(s,{get children(){return[o(e.Trigger,{"data-slot":"collapsible-trigger",get children(){var a=c();return a.firstChild,i(a,o(e.Arrow,{}),null),a}}),o(e.Content,{"data-slot":"collapsible-content",get children(){return g()}})]}}))};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Basic = (props) => (
  <mod.Collapsible {...props}>
    <mod.Collapsible.Trigger data-slot="collapsible-trigger">
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span>Details</span>
        <mod.Collapsible.Arrow />
      </div>
    </mod.Collapsible.Trigger>
    <mod.Collapsible.Content data-slot="collapsible-content">
      <div style={{ color: "var(--text-weak)", "padding-top": "8px" }}>
        Optional details sit here.
      </div>
    </mod.Collapsible.Content>
  </mod.Collapsible>
);
`,...t.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const Ghost = (props) => (
  <mod.Collapsible {...props}>
    <mod.Collapsible.Trigger data-slot="collapsible-trigger">
      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
        <span>Ghost trigger</span>
        <mod.Collapsible.Arrow />
      </div>
    </mod.Collapsible.Trigger>
    <mod.Collapsible.Content data-slot="collapsible-content">
      <div style={{ color: "var(--text-weak)", "padding-top": "8px" }}>
        Ghost content.
      </div>
    </mod.Collapsible.Content>
  </mod.Collapsible>
);
`,...l.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "normal",
    defaultOpen: true
  },
  render: props => <mod.Collapsible {...props}>
      <mod.Collapsible.Trigger data-slot="collapsible-trigger">
        <div style={{
        display: "flex",
        "align-items": "center",
        gap: "8px"
      }}>
          <span>Details</span>
          <mod.Collapsible.Arrow />
        </div>
      </mod.Collapsible.Trigger>
      <mod.Collapsible.Content data-slot="collapsible-content">
        <div style={{
        color: "var(--text-weak)",
        "padding-top": "8px"
      }}>Optional details sit here.</div>
      </mod.Collapsible.Content>
    </mod.Collapsible>
}`,...t.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "ghost",
    defaultOpen: false
  },
  render: props => <mod.Collapsible {...props}>
      <mod.Collapsible.Trigger data-slot="collapsible-trigger">
        <div style={{
        display: "flex",
        "align-items": "center",
        gap: "8px"
      }}>
          <span>Ghost trigger</span>
          <mod.Collapsible.Arrow />
        </div>
      </mod.Collapsible.Trigger>
      <mod.Collapsible.Content data-slot="collapsible-content">
        <div style={{
        color: "var(--text-weak)",
        "padding-top": "8px"
      }}>Ghost content.</div>
      </mod.Collapsible.Content>
    </mod.Collapsible>
}`,...l.parameters?.docs?.source}}};const w=["Basic","Ghost"];export{t as Basic,l as Ghost,w as __namedExportsOrder,f as default};
