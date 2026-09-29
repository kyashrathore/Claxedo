import{s as x,b as e,m as g,i as n,S as f,t as m,c as k}from"./iframe-D288tw9h.js";import{C as h}from"./3PUKRKSL-lXEBGSVb.js";import"./preload-helper-D9Z9MdNV.js";import"./VI7QYH27-BdSgIyCK.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";var S=m('<svg class="checkbox-v2-icon checkbox-v2-icon--check"width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"stroke=#FAFAFA stroke-width=1>'),y=m('<svg class="checkbox-v2-icon checkbox-v2-icon--minus"width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M12.75 8H3.25"stroke=#FAFAFA stroke-linejoin=round stroke-width=1>'),V=m("<div data-slot=checkbox-v2-text><span data-slot=checkbox-v2-label-text>"),I=m("<div data-slot=checkbox-v2-row><div data-slot=checkbox-v2-control-stack>"),w=m("<span data-slot=checkbox-v2-description class=ui-checkbox-v2-description>");function a(t){const[r,i]=x(t,["class","classList","label","description","hideLabel"]);return e(h,g(i,{"data-slot":"checkbox-v2",get classList(){return{...r.classList,[r.class??""]:!!r.class}},get children(){return[(()=>{var s=I(),b=s.firstChild;return n(s,e(h.Input,{"data-slot":"checkbox-v2-input"}),b),n(b,e(h.Control,{"data-slot":"checkbox-v2-control",class:"ui-checkbox-v2-control",get children(){return e(h.Indicator,{"data-slot":"checkbox-v2-indicator",get children(){return[S(),y()]}})}})),n(s,e(h.Label,{"data-slot":"checkbox-v2-label",get classList(){return{"ui-checkbox-v2-label":!0,"sr-only":r.hideLabel}},get children(){var p=V(),v=p.firstChild;return n(v,()=>r.label),n(p,e(f,{get when(){return r.description},children:C=>(()=>{var u=w();return n(u,C),u})()}),null),p}}),null),s})(),e(h.ErrorMessage,{"data-slot":"checkbox-v2-error",class:"ui-checkbox-v2-error"})]}}))}var _=m("<div style=display:grid;gap:12px><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:#808080>Checked: "),$=m("<div style=display:grid;gap:20px>");const A='### Overview\nBinary and tri-state checkbox using Kobalte Checkbox.\n\n### API\n- Forwards Kobalte Checkbox props (`checked`, `defaultChecked`, `onChange`, `indeterminate`, `name`, `required`, `validationState`, `disabled`, etc.).\n- Adds `label`, optional `description`, and `hideLabel`.\n\n### Behavior\n- Controlled or uncontrolled via `checked` / `defaultChecked`.\n- Indeterminate is driven by the `indeterminate` prop (pass a reactive boolean, e.g. `indeterminate={flag()}`).\n\n### Theming/tokens\n- Uses `data-slot="checkbox-v2"` and slot attributes aligned with radio item layout.\n',H={title:"UI V2/Checkbox",id:"components-checkbox-v2",component:a,tags:["autodocs"],parameters:{docs:{description:{component:A}}}},c={render:()=>e(a,{defaultChecked:!1,name:"terms",label:"Accept terms",description:"You must accept to continue."})},d={render:()=>{const[t,r]=k(!1);return(()=>{var i=_(),s=i.firstChild;return s.firstChild,n(i,e(a,{name:"controlled",get checked(){return t()},onChange:r,label:"Controlled checkbox",description:"Toggled from Storybook state."}),s),n(s,()=>String(t()),null),i})()}},o={render:()=>{const[t,r]=k(!0),[i,s]=k(!1);return e(a,{name:"indeterminate-demo",get checked(){return i()},get indeterminate(){return t()},onChange:b=>{s(b),b&&r(!1)},label:"Select all",description:"Starts indeterminate; checking clears mixed state."})}},l={render:()=>(()=>{var t=$();return n(t,e(a,{name:"s1",label:"Default",description:"Helper text."}),null),n(t,e(a,{name:"s2",defaultChecked:!0,label:"Checked"}),null),n(t,e(a,{name:"s3",indeterminate:!0,label:"Indeterminate"}),null),n(t,e(a,{name:"s4",disabled:!0,label:"Disabled"}),null),n(t,e(a,{name:"s5",disabled:!0,defaultChecked:!0,label:"Checked disabled"}),null),n(t,e(a,{name:"s6",disabled:!0,indeterminate:!0,label:"Indeterminate disabled"}),null),n(t,e(a,{name:"s7",label:"Invalid",description:"Must be checked.",required:!0,validationState:"invalid"}),null),t})()};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Basic = () => (
  <CheckboxV2
    defaultChecked={false}
    name="terms"
    label="Accept terms"
    description="You must accept to continue."
  />
);
`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Controlled = () => {
  const [checked, setChecked] = createSignal(false);
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <CheckboxV2
        name="controlled"
        checked={checked()}
        onChange={setChecked}
        label="Controlled checkbox"
        description="Toggled from Storybook state."
      />
      <div
        style={{
          "font-family": "var(--v2-font-family-sans)",
          "font-size": "12px",
          color: "#808080",
        }}
      >
        Checked: {String(checked())}
      </div>
    </div>
  );
};
`,...d.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Indeterminate = () => {
  const [indeterminate, setIndeterminate] = createSignal(true);
  const [checked, setChecked] = createSignal(false);
  return (
    <CheckboxV2
      name="indeterminate-demo"
      checked={checked()}
      indeterminate={indeterminate()}
      onChange={(v) => {
        setChecked(v);
        if (v) setIndeterminate(false);
      }}
      label="Select all"
      description="Starts indeterminate; checking clears mixed state."
    />
  );
};
`,...o.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "20px" }}>
    <CheckboxV2 name="s1" label="Default" description="Helper text." />
    <CheckboxV2 name="s2" defaultChecked label="Checked" />
    <CheckboxV2 name="s3" indeterminate label="Indeterminate" />
    <CheckboxV2 name="s4" disabled label="Disabled" />
    <CheckboxV2 name="s5" disabled defaultChecked label="Checked disabled" />
    <CheckboxV2
      name="s6"
      disabled
      indeterminate
      label="Indeterminate disabled"
    />
    <CheckboxV2
      name="s7"
      label="Invalid"
      description="Must be checked."
      required
      validationState="invalid"
    />
  </div>
);
`,...l.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => <CheckboxV2 defaultChecked={false} name="terms" label="Accept terms" description="You must accept to continue." />
}`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [checked, setChecked] = createSignal(false);
    return <div style={{
      display: "grid",
      gap: "12px"
    }}>
        <CheckboxV2 name="controlled" checked={checked()} onChange={setChecked} label="Controlled checkbox" description="Toggled from Storybook state." />
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "#808080"
      }}>
          Checked: {String(checked())}
        </div>
      </div>;
  }
}`,...d.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [indeterminate, setIndeterminate] = createSignal(true);
    const [checked, setChecked] = createSignal(false);
    return <CheckboxV2 name="indeterminate-demo" checked={checked()} indeterminate={indeterminate()} onChange={v => {
      setChecked(v);
      if (v) setIndeterminate(false);
    }} label="Select all" description="Starts indeterminate; checking clears mixed state." />;
  }
}`,...o.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px"
  }}>
      <CheckboxV2 name="s1" label="Default" description="Helper text." />
      <CheckboxV2 name="s2" defaultChecked label="Checked" />
      <CheckboxV2 name="s3" indeterminate label="Indeterminate" />
      <CheckboxV2 name="s4" disabled label="Disabled" />
      <CheckboxV2 name="s5" disabled defaultChecked label="Checked disabled" />
      <CheckboxV2 name="s6" disabled indeterminate label="Indeterminate disabled" />
      <CheckboxV2 name="s7" label="Invalid" description="Must be checked." required validationState="invalid" />
    </div>
}`,...l.parameters?.docs?.source}}};const T=["Basic","Controlled","Indeterminate","States"];export{c as Basic,d as Controlled,o as Indeterminate,l as States,T as __namedExportsOrder,H as default};
