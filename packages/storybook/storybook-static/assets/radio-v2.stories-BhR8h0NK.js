import{s as V,b as e,m as y,S as m,i,t as p,c as R}from"./iframe-D288tw9h.js";import{e as o}from"./H7BK6JF7-Auk6LkTy.js";import"./preload-helper-D9Z9MdNV.js";import"./ZZYKR3VO-DWSPmSPl.js";var g=p("<div data-slot=radio-v2-items>"),I=p("<div data-slot=radio-v2-item-control-stack>"),h=p("<div data-slot=radio-v2-item-text><span data-slot=radio-v2-item-label-text class=ui-radio-v2-item-label-text>"),G=p("<span data-slot=radio-v2-item-description class=ui-radio-v2-item-description>");function c(t){const[l,u]=V(t,["class","classList","children","label","description","hideLabel"]);return e(o,y(u,{"data-component":"radio-v2",get classList(){return{...l.classList,[l.class??""]:!!l.class}},get children(){return[e(m,{get when(){return l.label},children:a=>e(o.Label,{"data-slot":"radio-v2-label",get classList(){return{"sr-only":l.hideLabel}},get children(){return a()}})}),e(m,{get when(){return l.description},children:a=>e(o.Description,{"data-slot":"radio-v2-description",get children(){return a()}})}),(()=>{var a=g();return i(a,()=>l.children),a})(),e(o.ErrorMessage,{"data-slot":"radio-v2-error",class:"ui-radio-v2-error"})]}}))}function n(t){const[l,u]=V(t,["class","classList","label","description","hideLabel"]);return e(o.Item,y(u,{"data-slot":"radio-v2-item",get classList(){return{...l.classList,[l.class??""]:!!l.class}},get children(){return[e(o.ItemInput,{"data-slot":"radio-v2-item-input"}),(()=>{var a=I();return i(a,e(o.ItemControl,{"data-slot":"radio-v2-item-control",class:"ui-radio-v2-item-control",get children(){return e(o.ItemIndicator,{"data-slot":"radio-v2-item-indicator"})}})),a})(),e(o.ItemLabel,{"data-slot":"radio-v2-item-label",get classList(){return{"sr-only":l.hideLabel}},get children(){var a=h(),v=a.firstChild;return i(v,()=>l.label),i(a,e(m,{get when(){return l.description},children:f=>(()=>{var b=G();return i(b,f),b})()}),null),a}})]}}))}var O=p("<div style=display:grid;gap:12px><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:#808080>Selected: "),k=p("<div style=display:grid;gap:20px>");const D='### Overview\nSingle-select options using Kobalte RadioGroup.\n\n### API\n- `RadioGroupV2` forwards Kobalte RadioGroup props (`value`, `defaultValue`, `onChange`, `name`, `required`, `validationState`, `disabled`).\n- `RadioItemV2` forwards Kobalte item props (`value`, `disabled`), and adds `label` and optional `description`.\n\n### Behavior\n- Controlled or uncontrolled via `value` / `defaultValue` on the group (items declare `value` only).\n\n### Theming/tokens\n- Uses `data-component="radio-v2"` and slot attributes.\n',$={title:"UI V2/Radio",id:"components-radio-v2",component:c,tags:["autodocs"],parameters:{docs:{description:{component:D}}}},r={render:()=>e(c,{label:"Notification frequency",defaultValue:"daily",name:"frequency",get children(){return[e(n,{value:"daily",label:"Daily",description:"Once per day at 9am."}),e(n,{value:"weekly",label:"Weekly",description:"Every Monday morning."}),e(n,{value:"never",label:"Never",description:"No notifications."})]}})},d={render:()=>{const[t,l]=R("weekly");return(()=>{var u=O(),a=u.firstChild;return a.firstChild,i(u,e(c,{label:"Controlled",get value(){return t()},onChange:v=>l(v),name:"controlled-frequency",get children(){return[e(n,{value:"daily",label:"Daily"}),e(n,{value:"weekly",label:"Weekly"}),e(n,{value:"never",label:"Never"})]}}),a),i(a,t,null),u})()}},s={render:()=>(()=>{var t=k();return i(t,e(c,{label:"Default",defaultValue:"a",name:"state-default",get children(){return[e(n,{value:"a",label:"Option A"}),e(n,{value:"b",label:"Option B",description:"Has a description."})]}}),null),i(t,e(c,{label:"Disabled group",defaultValue:"a",name:"state-disabled",disabled:!0,get children(){return[e(n,{value:"a",label:"Option A"}),e(n,{value:"b",label:"Option B"})]}}),null),i(t,e(c,{label:"Disabled item",defaultValue:"a",name:"state-disabled-item",get children(){return[e(n,{value:"a",label:"Enabled"}),e(n,{value:"b",label:"Disabled",disabled:!0})]}}),null),i(t,e(c,{label:"Invalid",description:"Pick one option.",defaultValue:"a",name:"state-invalid",validationState:"invalid",required:!0,get children(){return[e(n,{value:"a",label:"Option A"}),e(n,{value:"b",label:"Option B"})]}}),null),t})()};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Basic = () => (
  <RadioGroupV2
    label="Notification frequency"
    defaultValue="daily"
    name="frequency"
  >
    <RadioItemV2
      value="daily"
      label="Daily"
      description="Once per day at 9am."
    />
    <RadioItemV2
      value="weekly"
      label="Weekly"
      description="Every Monday morning."
    />
    <RadioItemV2 value="never" label="Never" description="No notifications." />
  </RadioGroupV2>
);
`,...r.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Controlled = () => {
  const [value, setValue] = createSignal("weekly");
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <RadioGroupV2
        label="Controlled"
        value={value()}
        onChange={(v) => setValue(v)}
        name="controlled-frequency"
      >
        <RadioItemV2 value="daily" label="Daily" />
        <RadioItemV2 value="weekly" label="Weekly" />
        <RadioItemV2 value="never" label="Never" />
      </RadioGroupV2>
      <div
        style={{
          "font-family": "var(--v2-font-family-sans)",
          "font-size": "12px",
          color: "#808080",
        }}
      >
        Selected: {value()}
      </div>
    </div>
  );
};
`,...d.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "20px" }}>
    <RadioGroupV2 label="Default" defaultValue="a" name="state-default">
      <RadioItemV2 value="a" label="Option A" />
      <RadioItemV2
        value="b"
        label="Option B"
        description="Has a description."
      />
    </RadioGroupV2>

    <RadioGroupV2
      label="Disabled group"
      defaultValue="a"
      name="state-disabled"
      disabled
    >
      <RadioItemV2 value="a" label="Option A" />
      <RadioItemV2 value="b" label="Option B" />
    </RadioGroupV2>

    <RadioGroupV2
      label="Disabled item"
      defaultValue="a"
      name="state-disabled-item"
    >
      <RadioItemV2 value="a" label="Enabled" />
      <RadioItemV2 value="b" label="Disabled" disabled />
    </RadioGroupV2>

    <RadioGroupV2
      label="Invalid"
      description="Pick one option."
      defaultValue="a"
      name="state-invalid"
      validationState="invalid"
      required
    >
      <RadioItemV2 value="a" label="Option A" />
      <RadioItemV2 value="b" label="Option B" />
    </RadioGroupV2>
  </div>
);
`,...s.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <RadioGroupV2 label="Notification frequency" defaultValue="daily" name="frequency">
      <RadioItemV2 value="daily" label="Daily" description="Once per day at 9am." />
      <RadioItemV2 value="weekly" label="Weekly" description="Every Monday morning." />
      <RadioItemV2 value="never" label="Never" description="No notifications." />
    </RadioGroupV2>
}`,...r.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("weekly");
    return <div style={{
      display: "grid",
      gap: "12px"
    }}>
        <RadioGroupV2 label="Controlled" value={value()} onChange={v => setValue(v)} name="controlled-frequency">
          <RadioItemV2 value="daily" label="Daily" />
          <RadioItemV2 value="weekly" label="Weekly" />
          <RadioItemV2 value="never" label="Never" />
        </RadioGroupV2>
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "#808080"
      }}>
          Selected: {value()}
        </div>
      </div>;
  }
}`,...d.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px"
  }}>
      <RadioGroupV2 label="Default" defaultValue="a" name="state-default">
        <RadioItemV2 value="a" label="Option A" />
        <RadioItemV2 value="b" label="Option B" description="Has a description." />
      </RadioGroupV2>

      <RadioGroupV2 label="Disabled group" defaultValue="a" name="state-disabled" disabled>
        <RadioItemV2 value="a" label="Option A" />
        <RadioItemV2 value="b" label="Option B" />
      </RadioGroupV2>

      <RadioGroupV2 label="Disabled item" defaultValue="a" name="state-disabled-item">
        <RadioItemV2 value="a" label="Enabled" />
        <RadioItemV2 value="b" label="Disabled" disabled />
      </RadioGroupV2>

      <RadioGroupV2 label="Invalid" description="Pick one option." defaultValue="a" name="state-invalid" validationState="invalid" required>
        <RadioItemV2 value="a" label="Option A" />
        <RadioItemV2 value="b" label="Option B" />
      </RadioGroupV2>
    </div>
}`,...s.parameters?.docs?.source}}};const x=["Basic","Controlled","States"];export{r as Basic,d as Controlled,s as States,x as __namedExportsOrder,$ as default};
