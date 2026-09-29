import{s as h,b as e,m,S as d,i as c,t as u}from"./iframe-D288tw9h.js";import{S as a}from"./R6NHVR6N-B10qv1xI.js";import{c as b}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./VI7QYH27-BdSgIyCK.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";function n(o){const[i,p]=h(o,["children","class","hideLabel","description"]);return e(a,m(p,{get class(){return i.class},"data-component":"switch",get children(){return[e(a.Input,{"data-slot":"switch-input"}),e(d,{get when(){return i.children},get children(){return e(a.Label,{"data-slot":"switch-label",get classList(){return{"sr-only":i.hideLabel}},get children(){return i.children}})}}),e(d,{get when(){return i.description},get children(){return e(a.Description,{"data-slot":"switch-description",get children(){return i.description}})}}),e(a.ErrorMessage,{"data-slot":"switch-error"}),e(a.Control,{"data-slot":"switch-control",class:"ui-switch-control",get children(){return e(a.Thumb,{"data-slot":"switch-thumb",class:"ui-switch-thumb"})}})]}}))}const w=Object.freeze(Object.defineProperty({__proto__:null,Switch:n},Symbol.toStringTag,{value:"Module"}));var g=u("<div style=display:grid;gap:12px>");const S=`### Overview
Toggle control for binary settings.

Use in settings panels or forms.

### API
- Uses Kobalte Switch props (\`checked\`, \`defaultChecked\`, \`onChange\`).
- Optional: \`hideLabel\`, \`description\`.
- Children render as the label.

### Variants and states
- Checked/unchecked, disabled states.

### Behavior
- Controlled or uncontrolled usage via Kobalte props.

### Accessibility
- TODO: confirm aria attributes from Kobalte.

### Theming/tokens
- Uses \`data-component="switch"\` and slot attributes.

`,l=b({title:"UI/Switch",mod:w,args:{defaultChecked:!0,children:"Enable notifications"}}),x={title:"UI/Switch",id:"components-switch",component:l.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:S}}}},t=l.Basic,r={render:()=>(()=>{var o=g();return c(o,e(n,{defaultChecked:!0,children:"Enabled"}),null),c(o,e(n,{children:"Disabled"}),null),c(o,e(n,{disabled:!0,children:"Disabled switch"}),null),c(o,e(n,{description:"Optional description",children:"With description"}),null),o})()},s={args:{children:"Hidden label",hideLabel:!0,defaultChecked:!0}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  47 | }
  48 |
> 49 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  50 |
  51 | export const States = {
  52 |   render: () => (`,...t.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Switch defaultChecked>Enabled</mod.Switch>
    <mod.Switch>Disabled</mod.Switch>
    <mod.Switch disabled>Disabled switch</mod.Switch>
    <mod.Switch description="Optional description">With description</mod.Switch>
  </div>
);
`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const HiddenLabel = () => (
  <story.meta.component hideLabel defaultChecked>
    Hidden label
  </story.meta.component>
);
`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:"story.Basic",...t.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Switch defaultChecked>Enabled</mod.Switch>
      <mod.Switch>Disabled</mod.Switch>
      <mod.Switch disabled>Disabled switch</mod.Switch>
      <mod.Switch description="Optional description">With description</mod.Switch>
    </div>
}`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    children: "Hidden label",
    hideLabel: true,
    defaultChecked: true
  }
}`,...s.parameters?.docs?.source}}};const _=["Basic","States","HiddenLabel"];export{t as Basic,s as HiddenLabel,r as States,_ as __namedExportsOrder,x as default};
