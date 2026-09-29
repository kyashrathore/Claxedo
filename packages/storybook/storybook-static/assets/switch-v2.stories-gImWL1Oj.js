import{s as h,b as e,m as p,S as u,i as o,t as m}from"./iframe-D288tw9h.js";import{S as c}from"./R6NHVR6N-B10qv1xI.js";import"./preload-helper-D9Z9MdNV.js";import"./VI7QYH27-BdSgIyCK.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";function i(r){const[n,d]=h(r,["children","class","hideLabel"]);return e(c,p(d,{get class(){return n.class},"data-component":"switch",get children(){return[e(c.Input,{"data-slot":"switch-input"}),e(u,{get when(){return n.children},children:l=>e(c.Label,{"data-slot":"switch-label",get classList(){return{"sr-only":n.hideLabel}},get children(){return l()}})}),e(c.Control,{"data-slot":"switch-control",class:"ui-switch-control",get children(){return e(c.Thumb,{"data-slot":"switch-thumb",class:"ui-switch-thumb"})}}),e(c.ErrorMessage,{"data-slot":"switch-error"})]}}))}var b=m("<div style=display:grid;gap:12px>");const w=`### Overview
Toggle control for binary settings.

Use in settings panels or forms.

### API
- Uses Kobalte Switch props (\`checked\`, \`defaultChecked\`, \`onChange\`).
- Optional: \`hideLabel\`.
- Children render as the label.

### Variants and states
- Checked/unchecked, disabled states.

### Behavior
- Controlled or uncontrolled usage via Kobalte props.

### Accessibility
- TODO: confirm aria attributes from Kobalte.

### Theming/tokens
- Uses \`data-component="switch"\` and slot attributes.

`,L={title:"UI V2/Switch",id:"components-switch-v2",component:i,tags:["autodocs"],parameters:{docs:{description:{component:w}}},args:{defaultChecked:!0,children:"Enable notifications"}},t={},s={render:()=>(()=>{var r=b();return o(r,e(i,{defaultChecked:!0,children:"Enabled"}),null),o(r,e(i,{children:"Disabled"}),null),o(r,e(i,{disabled:!0,children:"Disabled switch"}),null),r})()},a={args:{children:"Hidden label",hideLabel:!0,defaultChecked:!0}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Basic = () => <Switch defaultChecked>Enable notifications</Switch>;
`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <Switch defaultChecked>Enabled</Switch>
    <Switch>Disabled</Switch>
    <Switch disabled>Disabled switch</Switch>
  </div>
);
`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const HiddenLabel = () => (
  <Switch defaultChecked hideLabel>
    Hidden label
  </Switch>
);
`,...a.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:"{}",...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <Switch defaultChecked>Enabled</Switch>
      <Switch>Disabled</Switch>
      <Switch disabled>Disabled switch</Switch>
    </div>
}`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  args: {
    children: "Hidden label",
    hideLabel: true,
    defaultChecked: true
  }
}`,...a.parameters?.docs?.source}}};const y=["Basic","States","HiddenLabel"];export{t as Basic,a as HiddenLabel,s as States,y as __namedExportsOrder,L as default};
