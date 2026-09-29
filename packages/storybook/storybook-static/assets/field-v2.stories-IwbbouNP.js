import{c as m,i as l,b as e,t as F,x as h}from"./iframe-D288tw9h.js";import{F as r}from"./field-v2-C-0BIONQ.js";import{I as S}from"./inline-input-v2-CeY98Rut.js";import{T as p}from"./text-input-v2-BV1Dxsfk.js";import{T as v}from"./textarea-v2-Br5keQpV.js";import"./preload-helper-D9Z9MdNV.js";import"./tooltip-v2-ejrje0OW.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var n=F("<div style=width:280px>");const b='### Overview\nComposable field layout for TextInput, Textarea, and InlineInput v2.\n\n### Usage\n```tsx\n<Field invalid>\n  <Field.Label tooltip="Helper">Label</Field.Label>\n  <Field.Prefix>Prefix</Field.Prefix>\n  <Field.Control>\n    <TextInputV2 placeholder="Text" />\n  </Field.Control>\n  <Field.Suffix>Suffix</Field.Suffix>\n</Field>\n```\n\nOmit `Field.Control` and place the input directly inside `Field` — a11y props are merged automatically.\n\n### API\n- `Field`: `invalid` propagates to the control.\n- `Field.Label`: `tooltip` shows the info icon with tooltip text.\n- `Field.Prefix` / `Field.Suffix`: helper copy above / below the control.\n- `Field.Control`: optional wrapper (marker only).\n',A={title:"UI V2/Field",id:"components-field-v2",subcomponents:{Label:r.Label,Prefix:r.Prefix,Suffix:r.Suffix,Control:r.Control},tags:["autodocs"],parameters:{frameHeight:"500px",frameBackground:"#fff",docs:{description:{component:b}}}},t={render:()=>(()=>{var i=n();return l(i,e(r,{get children(){return[e(r.Label,{tooltip:"Additional context",children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(r.Control,{get children(){return e(p,{placeholder:"Text",showCopyButton:!0})}}),e(r.Suffix,{children:"Suffix"})]}})),i})()},a={render:()=>(()=>{var i=n();return l(i,e(r,{get children(){return[e(r.Label,{children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(p,{placeholder:"Text"}),e(r.Suffix,{children:"Suffix"})]}})),i})()},d={render:()=>(()=>{var i=n();return l(i,e(r,{get children(){return[e(r.Label,{children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(v,{placeholder:"Text"}),e(r.Suffix,{children:"Suffix"})]}})),i})()},o={render:()=>(()=>{var i=n();return l(i,e(r,{get children(){return[e(r.Label,{children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(S,{prefix:"USD",placeholder:"0.00",numeric:!0,showCopyButton:!0}),e(r.Suffix,{children:"Suffix"})]}})),i})()},u={render:()=>(()=>{var i=n();return l(i,e(r,{invalid:!0,get children(){return[e(r.Label,{children:"Label"}),e(r.Prefix,{children:"Prefix"}),e(p,{placeholder:"Text",defaultValue:"Invalid",showCopyButton:!0}),e(r.Suffix,{children:"Suffix"})]}})),i})()},f={render:()=>{const[i,c]=m("");return(()=>{var x=n();return l(x,e(r,{get children(){return[e(r.Label,{children:"Amount"}),e(r.Control,{get children(){return e(p,{placeholder:"0.00",get value(){return i()},onInput:s=>c(s.currentTarget.value),numeric:!0})}}),e(r.Suffix,{get children(){return h(()=>!!i())()?`Entered: ${i()}`:"Suffix"}})]}})),x})()}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "280px"
  }}>
      <Field>
        <Field.Label tooltip="Additional context">Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <Field.Control>
          <TextInputV2 placeholder="Text" showCopyButton />
        </Field.Control>
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
}`,...t.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "280px"
  }}>
      <Field>
        <Field.Label>Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <TextInputV2 placeholder="Text" />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
}`,...a.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "280px"
  }}>
      <Field>
        <Field.Label>Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <TextareaV2 placeholder="Text" />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
}`,...d.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "280px"
  }}>
      <Field>
        <Field.Label>Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <InlineInputV2 prefix="USD" placeholder="0.00" numeric showCopyButton />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
}`,...o.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "280px"
  }}>
      <Field invalid>
        <Field.Label>Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <TextInputV2 placeholder="Text" defaultValue="Invalid" showCopyButton />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
}`,...u.parameters?.docs?.source}}};f.parameters={...f.parameters,docs:{...f.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("");
    return <div style={{
      width: "280px"
    }}>
        <Field>
          <Field.Label>Amount</Field.Label>
          <Field.Control>
            <TextInputV2 placeholder="0.00" value={value()} onInput={e => setValue(e.currentTarget.value)} numeric />
          </Field.Control>
          <Field.Suffix>{value() ? \`Entered: \${value()}\` : "Suffix"}</Field.Suffix>
        </Field>
      </div>;
  }
}`,...f.parameters?.docs?.source}}};const D=["TextInputExample","TextInputDirectChild","TextareaExample","InlineInputExample","Invalid","Controlled"];export{f as Controlled,o as InlineInputExample,u as Invalid,a as TextInputDirectChild,t as TextInputExample,d as TextareaExample,D as __namedExportsOrder,A as default};
