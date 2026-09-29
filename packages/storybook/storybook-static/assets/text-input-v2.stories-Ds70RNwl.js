import{i as t,b as e,c as v,t as f}from"./iframe-D288tw9h.js";import{F as n}from"./field-v2-C-0BIONQ.js";import{T as l}from"./text-input-v2-BV1Dxsfk.js";import"./preload-helper-D9Z9MdNV.js";import"./tooltip-v2-ejrje0OW.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var y=f("<div style=display:grid;gap:12px><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:var(--text-text-faint)>Value: "),x=f("<div style=display:grid;gap:20px;width:280px>"),V=f("<div style=display:grid;gap:24px;width:280px>");const g='### Overview\nCompact single-line text field with neutral elevation, optional trailing copy action, and theme tokens.\n\n### API\n- Forwards native `input` props (`value`, `defaultValue`, `placeholder`, `disabled`, `name`, `type`, etc.).\n- `showCopyButton`: Renders the trailing outline-copy control.\n- `copyLabel`: Accessible name for the copy button (default: "Copy").\n- `onCopyClick`: Handler for the copy button.\n- `invalid`: Error outline and danger text color.\n- `appearance`: `"base"` (28px) or `"large"` (32px).\n\n### States\n- **Hover**: neutral overlay on the raised surface.\n- **Focus** (`:focus-within`): focus border, elevation removed.\n- **Invalid**: danger border and text.\n- **Disabled**: 50% opacity.\n- Uses `data-component="text-input-v2"` with `--v2-background-bg-base`, `--v2-elevation-button-neutral`, `--v2-text-text-faint` (placeholder), and `--v2-icon-icon-muted` (copy icon).\n\n### Field\nCompose with `Field` for label, helper prefix/suffix, and tooltip — see the **Field** story.\n',D={title:"UI V2/TextInput",id:"components-text-input-v2",component:l,tags:["autodocs"],parameters:{frameHeight:"300px",frameBackground:"#fff",docs:{description:{component:g}}},args:{placeholder:"Placeholder",showCopyButton:!1,disabled:!1,invalid:!1,appearance:"base"},argTypes:{appearance:{control:"select",options:["base","large"]},showCopyButton:{control:"boolean"},disabled:{control:"boolean"},invalid:{control:"boolean"},placeholder:{control:"text"}}},r={},o={args:{placeholder:"api.example.com/v1",defaultValue:"https://api.example.com/v1",showCopyButton:!0,copyLabel:"Copy URL"}},p={render:()=>{const[a,h]=v("Controlled value");return(()=>{var u=y(),c=u.firstChild;return c.firstChild,t(u,e(l,{get value(){return a()},onInput:m=>h(m.currentTarget.value),placeholder:"Type here…"}),c),t(c,a,null),u})()}},d={render:()=>(()=>{var a=x();return t(a,e(l,{appearance:"base",placeholder:"Base (28px)",defaultValue:"Base"}),null),t(a,e(l,{appearance:"large",placeholder:"Large (32px)",defaultValue:"Large"}),null),t(a,e(l,{appearance:"large",placeholder:"Large with copy",defaultValue:"copy-me",showCopyButton:!0}),null),a})()},i={parameters:{frameHeight:"500px"},render:()=>(()=>{var a=V();return t(a,e(n,{get children(){return[e(n.Label,{tooltip:"Additional context",children:"Label"}),e(n.Prefix,{children:"Prefix"}),e(l,{placeholder:"Text",showCopyButton:!0}),e(n.Suffix,{children:"Suffix"})]}}),null),t(a,e(n,{invalid:!0,get children(){return[e(n.Label,{children:"Label"}),e(n.Prefix,{children:"Prefix"}),e(l,{placeholder:"Text",defaultValue:"Invalid",showCopyButton:!0}),e(n.Suffix,{children:"Suffix"})]}}),null),a})()},s={render:()=>(()=>{var a=x();return t(a,e(l,{placeholder:"Default"}),null),t(a,e(l,{placeholder:"With value",defaultValue:"Hello world"}),null),t(a,e(l,{placeholder:"With copy",defaultValue:"copy-me",showCopyButton:!0}),null),t(a,e(l,{placeholder:"Invalid",defaultValue:"Invalid value",invalid:!0,showCopyButton:!0}),null),t(a,e(l,{placeholder:"Disabled",disabled:!0}),null),t(a,e(l,{placeholder:"Disabled with value",defaultValue:"Read only",disabled:!0,showCopyButton:!0}),null),a})()};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Playground = () => (
  <TextInputV2
    placeholder="Placeholder"
    showCopyButton={false}
    disabled={false}
    invalid={false}
    appearance="base"
  />
);
`,...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const WithCopyButton = () => (
  <TextInputV2
    placeholder="api.example.com/v1"
    showCopyButton
    disabled={false}
    invalid={false}
    appearance="base"
    defaultValue="https://api.example.com/v1"
    copyLabel="Copy URL"
  />
);
`,...o.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Controlled = () => {
  const [value, setValue] = createSignal("Controlled value");
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <TextInputV2
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
`,...p.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Appearances = () => (
  <div style={{ display: "grid", gap: "20px", width: "280px" }}>
    <TextInputV2
      appearance="base"
      placeholder="Base (28px)"
      defaultValue="Base"
    />
    <TextInputV2
      appearance="large"
      placeholder="Large (32px)"
      defaultValue="Large"
    />
    <TextInputV2
      appearance="large"
      placeholder="Large with copy"
      defaultValue="copy-me"
      showCopyButton
    />
  </div>
);
`,...d.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Field = () => (
  <div style={{ display: "grid", gap: "24px", width: "280px" }}>
    <FieldV2>
      <FieldV2.Label tooltip="Additional context">Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <TextInputV2 placeholder="Text" showCopyButton />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
    <FieldV2 invalid>
      <FieldV2.Label>Label</FieldV2.Label>
      <FieldV2.Prefix>Prefix</FieldV2.Prefix>
      <TextInputV2 placeholder="Text" defaultValue="Invalid" showCopyButton />
      <FieldV2.Suffix>Suffix</FieldV2.Suffix>
    </FieldV2>
  </div>
);
`,...i.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const States = () => (
  <div style={{ display: "grid", gap: "20px", width: "280px" }}>
    <TextInputV2 placeholder="Default" />
    <TextInputV2 placeholder="With value" defaultValue="Hello world" />
    <TextInputV2
      placeholder="With copy"
      defaultValue="copy-me"
      showCopyButton
    />
    <TextInputV2
      placeholder="Invalid"
      defaultValue="Invalid value"
      invalid
      showCopyButton
    />
    <TextInputV2 placeholder="Disabled" disabled />
    <TextInputV2
      placeholder="Disabled with value"
      defaultValue="Read only"
      disabled
      showCopyButton
    />
  </div>
);
`,...s.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:"{}",...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    placeholder: "api.example.com/v1",
    defaultValue: "https://api.example.com/v1",
    showCopyButton: true,
    copyLabel: "Copy URL"
  }
}`,...o.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("Controlled value");
    return <div style={{
      display: "grid",
      gap: "12px"
    }}>
        <TextInputV2 value={value()} onInput={e => setValue(e.currentTarget.value)} placeholder="Type here…" />
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "var(--text-text-faint)"
      }}>
          Value: {value()}
        </div>
      </div>;
  }
}`,...p.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px",
    width: "280px"
  }}>
      <TextInputV2 appearance="base" placeholder="Base (28px)" defaultValue="Base" />
      <TextInputV2 appearance="large" placeholder="Large (32px)" defaultValue="Large" />
      <TextInputV2 appearance="large" placeholder="Large with copy" defaultValue="copy-me" showCopyButton />
    </div>
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
        <TextInputV2 placeholder="Text" showCopyButton />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
      <FieldV2 invalid>
        <FieldV2.Label>Label</FieldV2.Label>
        <FieldV2.Prefix>Prefix</FieldV2.Prefix>
        <TextInputV2 placeholder="Text" defaultValue="Invalid" showCopyButton />
        <FieldV2.Suffix>Suffix</FieldV2.Suffix>
      </FieldV2>
    </div>
}`,...i.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "20px",
    width: "280px"
  }}>
      <TextInputV2 placeholder="Default" />
      <TextInputV2 placeholder="With value" defaultValue="Hello world" />
      <TextInputV2 placeholder="With copy" defaultValue="copy-me" showCopyButton />
      <TextInputV2 placeholder="Invalid" defaultValue="Invalid value" invalid showCopyButton />
      <TextInputV2 placeholder="Disabled" disabled />
      <TextInputV2 placeholder="Disabled with value" defaultValue="Read only" disabled showCopyButton />
    </div>
}`,...s.parameters?.docs?.source}}};const W=["Playground","WithCopyButton","Controlled","Appearances","Field","States"];export{d as Appearances,p as Controlled,i as Field,r as Playground,s as States,o as WithCopyButton,W as __namedExportsOrder,D as default};
