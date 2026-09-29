import{i as l,b as e,c as m,t as c}from"./iframe-D288tw9h.js";import{F as r}from"./field-v2-C-0BIONQ.js";import{I as a}from"./inline-input-v2-CeY98Rut.js";import"./preload-helper-D9Z9MdNV.js";import"./tooltip-v2-ejrje0OW.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var v=c("<div style=display:grid;gap:12px;width:280px><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:var(--text-text-faint)>Value: "),x=c("<div style=display:grid;gap:20px;width:280px>"),V=c("<div style=display:grid;gap:24px;width:280px>");const b='### Overview\nSingle-line field with an inline prefix label, vertical divider, and the same states as TextInput v2.\n\n### API\n- `prefix`: Inline label in the leading segment (required).\n- `labelWidth`: Fixed prefix width (px number or CSS length). Omit for fit-content.\n- Forwards native `input` props (`value`, `defaultValue`, `placeholder`, `disabled`, etc.).\n- `showCopyButton`, `copyLabel`, `onCopyClick`: Optional trailing copy control.\n- `invalid`: Error outline and danger text color.\n- `appearance`: `"base"` (28px) or `"large"` (32px).\n- `numeric`: Tabular numerals on prefix and value.\n\n### States\n- **Hover**, **Focus**, **Invalid**, **Disabled** — same as TextInput v2 on the outer shell.\n\n### Field\nCompose with `Field` for label, helper prefix/suffix, and tooltip — see the **Field** story.\n',_={title:"UI V2/InlineInput",id:"components-inline-input-v2",component:a,tags:["autodocs"],parameters:{frameHeight:"400px",frameBackground:"#fff",docs:{description:{component:b}}},args:{prefix:"Label",placeholder:"Text",showCopyButton:!0,disabled:!1,invalid:!1,appearance:"base"},argTypes:{prefix:{control:"text"},labelWidth:{control:"number"},appearance:{control:"select",options:["base","large"]},showCopyButton:{control:"boolean"},disabled:{control:"boolean"},invalid:{control:"boolean"},placeholder:{control:"text"}}},t={},o={render:()=>{const[n,f]=m("42");return(()=>{var s=v(),u=s.firstChild;return u.firstChild,l(s,e(a,{prefix:"Amount",get value(){return n()},onInput:h=>f(h.currentTarget.value),placeholder:"0.00",numeric:!0}),u),l(u,n,null),s})()}},i={render:()=>(()=>{var n=x();return l(n,e(a,{prefix:"Label",appearance:"base",placeholder:"Text",showCopyButton:!0}),null),l(n,e(a,{prefix:"Label",appearance:"large",placeholder:"Text",showCopyButton:!0}),null),l(n,e(a,{prefix:"Label",labelWidth:50,placeholder:"Text",showCopyButton:!0}),null),l(n,e(a,{prefix:"Long label",placeholder:"Text",showCopyButton:!0}),null),n})()},p={parameters:{frameHeight:"500px"},render:()=>(()=>{var n=V();return l(n,e(r,{get children(){return[e(r.Label,{tooltip:"Additional context",children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(a,{prefix:"USD",placeholder:"0.00",numeric:!0,showCopyButton:!0}),e(r.Suffix,{children:"Suffix"})]}}),null),l(n,e(r,{invalid:!0,get children(){return[e(r.Label,{children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(a,{prefix:"USD",placeholder:"0.00",defaultValue:"Invalid",showCopyButton:!0}),e(r.Suffix,{children:"Suffix"})]}}),null),n})()},d={render:()=>(()=>{var n=x();return l(n,e(a,{prefix:"Label",placeholder:"Text",showCopyButton:!0}),null),l(n,e(a,{prefix:"Label",placeholder:"Text",defaultValue:"Hello",showCopyButton:!0}),null),l(n,e(a,{prefix:"Label",placeholder:"Text",defaultValue:"Invalid",invalid:!0,showCopyButton:!0}),null),l(n,e(a,{prefix:"Label",placeholder:"Text",disabled:!0,showCopyButton:!0}),null),n})()};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Playground = () => (
  <InlineInputV2
    prefix="Label"
    placeholder="Text"
    showCopyButton
    disabled={false}
    invalid={false}
    appearance="base"
  />
);
`,...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Controlled = () => {
  const [value, setValue] = createSignal("42");
  return (
    <div style={{ display: "grid", gap: "12px", width: "280px" }}>
      <InlineInputV2
        prefix="Amount"
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        placeholder="0.00"
        numeric
      />
      <div
        style={{
          "font-family": "var(--v2-font-family-sans)",
          "font-size": "12px",
          color: "var(--text-text-faint)",
        }}
      >
        Value: {value()}
      </div>
    </div>
  );
};
`,...o.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Appearances = () => (
  <div style={{ display: "grid", gap: "20px", width: "280px" }}>
    <InlineInputV2
      prefix="Label"
      appearance="base"
      placeholder="Text"
      showCopyButton
    />
    <InlineInputV2
      prefix="Label"
      appearance="large"
      placeholder="Text"
      showCopyButton
    />
    <InlineInputV2
      prefix="Label"
      labelWidth={50}
      placeholder="Text"
      showCopyButton
    />
    <InlineInputV2 prefix="Long label" placeholder="Text" showCopyButton />
  </div>
);
`,...i.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Field = () => (
  <div style={{ display: "grid", gap: "24px", width: "280px" }}>
    <FieldV2>
      <FieldV2.Label tooltip="Additional context">Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <InlineInputV2 prefix="USD" placeholder="0.00" numeric showCopyButton />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
    <FieldV2 invalid>
      <FieldV2.Label>Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <InlineInputV2
        prefix="USD"
        placeholder="0.00"
        defaultValue="Invalid"
        showCopyButton
      />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
  </div>
);
`,...p.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "20px", width: "280px" }}>
    <InlineInputV2 prefix="Label" placeholder="Text" showCopyButton />
    <InlineInputV2
      prefix="Label"
      placeholder="Text"
      defaultValue="Hello"
      showCopyButton
    />
    <InlineInputV2
      prefix="Label"
      placeholder="Text"
      defaultValue="Invalid"
      invalid
      showCopyButton
    />
    <InlineInputV2 prefix="Label" placeholder="Text" disabled showCopyButton />
  </div>
);
`,...d.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:"{}",...t.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("42");
    return <div style={{
      display: "grid",
      gap: "12px",
      width: "280px"
    }}>
        <InlineInputV2 prefix="Amount" value={value()} onInput={e => setValue(e.currentTarget.value)} placeholder="0.00" numeric />
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "var(--text-text-faint)"
      }}>
          Value: {value()}
        </div>
      </div>;
  }
}`,...o.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px",
    width: "280px"
  }}>
      <InlineInputV2 prefix="Label" appearance="base" placeholder="Text" showCopyButton />
      <InlineInputV2 prefix="Label" appearance="large" placeholder="Text" showCopyButton />
      <InlineInputV2 prefix="Label" labelWidth={50} placeholder="Text" showCopyButton />
      <InlineInputV2 prefix="Long label" placeholder="Text" showCopyButton />
    </div>
}`,...i.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  parameters: {
    frameHeight: "500px"
  },
  render: () => <div style={{
    display: "grid",
    gap: "24px",
    width: "280px"
  }}>
      <FieldV2>
        <FieldV2.Label tooltip="Additional context">Label</FieldV2.Label>
        <FieldV2.Prefix>Prefix</FieldV2.Prefix>
        <InlineInputV2 prefix="USD" placeholder="0.00" numeric showCopyButton />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
      <FieldV2 invalid>
        <FieldV2.Label>Label</FieldV2.Label>
        <FieldV2.Prefix>Prefix</FieldV2.Prefix>
        <InlineInputV2 prefix="USD" placeholder="0.00" defaultValue="Invalid" showCopyButton />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
    </div>
}`,...p.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px",
    width: "280px"
  }}>
      <InlineInputV2 prefix="Label" placeholder="Text" showCopyButton />
      <InlineInputV2 prefix="Label" placeholder="Text" defaultValue="Hello" showCopyButton />
      <InlineInputV2 prefix="Label" placeholder="Text" defaultValue="Invalid" invalid showCopyButton />
      <InlineInputV2 prefix="Label" placeholder="Text" disabled showCopyButton />
    </div>
}`,...d.parameters?.docs?.source}}};const A=["Playground","Controlled","Appearances","Field","States"];export{i as Appearances,o as Controlled,p as Field,t as Playground,d as States,A as __namedExportsOrder,_ as default};
