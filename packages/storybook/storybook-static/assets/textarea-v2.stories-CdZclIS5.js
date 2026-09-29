import{c as x,i as l,b as e,t as p}from"./iframe-D288tw9h.js";import{F as t}from"./field-v2-C-0BIONQ.js";import{T as r}from"./textarea-v2-Br5keQpV.js";import"./preload-helper-D9Z9MdNV.js";import"./tooltip-v2-ejrje0OW.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";var v=p("<div style=display:grid;gap:12px;width:280px><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:var(--text-text-faint)>Value: "),V=p("<div style=display:grid;gap:24px;width:280px>"),m=p("<div style=display:grid;gap:20px;width:280px>");const h="### Overview\nMultiline text field with the same neutral elevation, states, and tokens as TextInput v2.\n\n### API\n- Forwards native `textarea` props (`value`, `defaultValue`, `placeholder`, `disabled`, `name`, `rows`, etc.).\n- `invalid`: Error outline and danger text color.\n\n### States\n- **Hover**: neutral overlay on the raised surface.\n- **Focus** (`:focus-within`): focus outline, elevation removed.\n- **Invalid**: danger outline and text.\n- **Disabled**: 50% opacity.\n\n### Field\nCompose with `Field` for label, helper prefix/suffix, and tooltip — see the **Field** story.\n",I={title:"UI V2/Textarea",id:"components-textarea-v2",component:r,tags:["autodocs"],parameters:{frameHeight:"400px",frameBackground:"#fff",docs:{description:{component:h}}},args:{placeholder:"Placeholder",disabled:!1,invalid:!1,rows:3},argTypes:{disabled:{control:"boolean"},invalid:{control:"boolean"},placeholder:{control:"text"},rows:{control:{type:"number",min:1,max:12}}}},n={},d={render:()=>{const[a,c]=x("Controlled value");return(()=>{var s=v(),u=s.firstChild;return u.firstChild,l(s,e(r,{get value(){return a()},onInput:f=>c(f.currentTarget.value),placeholder:"Type here…"}),u),l(u,a,null),s})()}},i={parameters:{frameHeight:"500px"},render:()=>(()=>{var a=V();return l(a,e(t,{get children(){return[e(t.Label,{tooltip:"Additional context",children:"Label"}),e(t.Prefix,{children:"Prefix"}),e(r,{placeholder:"Text"}),e(t.Suffix,{children:"Suffix"})]}}),null),l(a,e(t,{invalid:!0,get children(){return[e(t.Label,{children:"Label"}),e(t.Prefix,{children:"Prefix"}),e(r,{placeholder:"Text",defaultValue:"Invalid value"}),e(t.Suffix,{children:"Suffix"})]}}),null),a})()},o={render:()=>(()=>{var a=m();return l(a,e(r,{placeholder:"Default"}),null),l(a,e(r,{placeholder:"With value",defaultValue:"Hello world"}),null),l(a,e(r,{placeholder:"Invalid",defaultValue:"Invalid value",invalid:!0}),null),l(a,e(r,{placeholder:"Disabled",disabled:!0}),null),l(a,e(r,{placeholder:"Disabled with value",defaultValue:"Read only",disabled:!0}),null),a})()};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Playground = () => (
  <TextareaV2
    placeholder="Placeholder"
    disabled={false}
    invalid={false}
    rows={3}
  />
);
`,...n.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Controlled = () => {
  const [value, setValue] = createSignal("Controlled value");
  return (
    <div style={{ display: "grid", gap: "12px", width: "280px" }}>
      <TextareaV2
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        placeholder="Type here…"
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
`,...d.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Field = () => (
  <div style={{ display: "grid", gap: "24px", width: "280px" }}>
    <FieldV2>
      <FieldV2.Label tooltip="Additional context">Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <TextareaV2 placeholder="Text" />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
    <FieldV2 invalid>
      <FieldV2.Label>Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <TextareaV2 placeholder="Text" defaultValue="Invalid value" />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
  </div>
);
`,...i.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "20px", width: "280px" }}>
    <TextareaV2 placeholder="Default" />
    <TextareaV2 placeholder="With value" defaultValue="Hello world" />
    <TextareaV2 placeholder="Invalid" defaultValue="Invalid value" invalid />
    <TextareaV2 placeholder="Disabled" disabled />
    <TextareaV2
      placeholder="Disabled with value"
      defaultValue="Read only"
      disabled
    />
  </div>
);
`,...o.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:"{}",...n.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("Controlled value");
    return <div style={{
      display: "grid",
      gap: "12px",
      width: "280px"
    }}>
        <TextareaV2 value={value()} onInput={e => setValue(e.currentTarget.value)} placeholder="Type here…" />
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "var(--text-text-faint)"
      }}>
          Value: {value()}
        </div>
      </div>;
  }
}`,...d.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
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
        <TextareaV2 placeholder="Text" />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
      <FieldV2 invalid>
        <FieldV2.Label>Label</FieldV2.Label>
        <FieldV2.Prefix>Prefix</FieldV2.Prefix>
        <TextareaV2 placeholder="Text" defaultValue="Invalid value" />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
    </div>
}`,...i.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px",
    width: "280px"
  }}>
      <TextareaV2 placeholder="Default" />
      <TextareaV2 placeholder="With value" defaultValue="Hello world" />
      <TextareaV2 placeholder="Invalid" defaultValue="Invalid value" invalid />
      <TextareaV2 placeholder="Disabled" disabled />
      <TextareaV2 placeholder="Disabled with value" defaultValue="Read only" disabled />
    </div>
}`,...o.parameters?.docs?.source}}};const L=["Playground","Controlled","Field","States"];export{d as Controlled,i as Field,n as Playground,o as States,L as __namedExportsOrder,I as default};
