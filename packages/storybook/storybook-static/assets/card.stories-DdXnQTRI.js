import{C as i,a as c,b as d,c as p}from"./card-iNRH_RhR.js";import{B as m}from"./button-Bsz0PTzb.js";import{b as e}from"./iframe-D288tw9h.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./preload-helper-D9Z9MdNV.js";const u=`### Overview
Surface container for grouping related content and actions.

Pair with \`Button\` or \`Tag\` for quick actions.

### API
- Optional: \`variant\` (normal, error, warning, success, info).
- Accepts standard div props.

### Variants and states
- Semantic variants for status-driven messaging.

### Behavior
- Pure presentational container.

### Accessibility
- Provide headings or aria labels when used in isolation.

### Theming/tokens
- Uses \`data-component="card"\` with variant data attributes.

`,B={title:"UI/Card",id:"components-card",component:i,tags:["autodocs"],parameters:{docs:{description:{component:u}}},args:{variant:"normal"},argTypes:{variant:{control:"select",options:["normal","error","warning","success","info"]}},render:o=>e(i,{get variant(){return o.variant},get children(){return[e(c,{get variant(){return o.variant},children:"Card title"}),e(d,{children:"Small supporting text."}),e(p,{get children(){return e(m,{size:"small",variant:"secondary",children:"Action"})}})]}})},r={},a={args:{variant:"error"}},n={args:{variant:"warning"}},t={args:{variant:"success"}},s={args:{variant:"info"}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Normal = (props: {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}) => {
  return (
    <Card variant={props.variant}>
      <CardTitle variant={props.variant}>Card title</CardTitle>
      <CardDescription>Small supporting text.</CardDescription>
      <CardActions>
        <Button size="small" variant="secondary">
          Action
        </Button>
      </CardActions>
    </Card>
  );
};
`,...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Error = (props: {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}) => {
  return (
    <Card variant={props.variant}>
      <CardTitle variant={props.variant}>Card title</CardTitle>
      <CardDescription>Small supporting text.</CardDescription>
      <CardActions>
        <Button size="small" variant="secondary">
          Action
        </Button>
      </CardActions>
    </Card>
  );
};
`,...a.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Warning = (props: {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}) => {
  return (
    <Card variant={props.variant}>
      <CardTitle variant={props.variant}>Card title</CardTitle>
      <CardDescription>Small supporting text.</CardDescription>
      <CardActions>
        <Button size="small" variant="secondary">
          Action
        </Button>
      </CardActions>
    </Card>
  );
};
`,...n.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Success = (props: {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}) => {
  return (
    <Card variant={props.variant}>
      <CardTitle variant={props.variant}>Card title</CardTitle>
      <CardDescription>Small supporting text.</CardDescription>
      <CardActions>
        <Button size="small" variant="secondary">
          Action
        </Button>
      </CardActions>
    </Card>
  );
};
`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Info = (props: {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}) => {
  return (
    <Card variant={props.variant}>
      <CardTitle variant={props.variant}>Card title</CardTitle>
      <CardDescription>Small supporting text.</CardDescription>
      <CardActions>
        <Button size="small" variant="secondary">
          Action
        </Button>
      </CardActions>
    </Card>
  );
};
`,...s.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:"{}",...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "error"
  }
}`,...a.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "warning"
  }
}`,...n.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "success"
  }
}`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "info"
  }
}`,...s.parameters?.docs?.source}}};const T=["Normal","Error","Warning","Success","Info"];export{a as Error,s as Info,r as Normal,t as Success,n as Warning,T as __namedExportsOrder,B as default};
