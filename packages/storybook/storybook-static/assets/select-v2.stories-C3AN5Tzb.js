import{s as _,r as $,b as a,m as k,n as I,i as x,x as B,S as O,t as f,c as b}from"./iframe-D288tw9h.js";import{F as C}from"./field-v2-C-0BIONQ.js";import{S as i,s as L}from"./select-item-CRcMIsHa.js";import"./preload-helper-D9Z9MdNV.js";import"./tooltip-v2-ejrje0OW.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./AGCGV7T6-D4ycykph.js";import"./ZZYKR3VO-DWSPmSPl.js";import"./DAEKM6TG-BBrc5b-v.js";import"./NGHEENNE-Dk4g74Tj.js";var M=f('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M11 9.5L8 6.5L5 9.5"stroke=currentColor stroke-width=1 stroke-linecap=round stroke-linejoin=round>'),W=f('<svg width=14 height=14 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"stroke=currentColor stroke-width=1 stroke-linecap=round stroke-linejoin=round>'),A=f("<div data-slot=select-v2-value>"),D=f("<span data-slot=select-v2-chevron class=ui-select-v2-chevron aria-hidden=true>"),H=f("<div data-slot=menu-v2-group-label>");function T(r,e){if(!e)return[{category:"",options:r}];const l=new Map;for(const t of r){const o=e(t),v=l.get(o);v?v.push(t):l.set(o,[t])}return[...l.entries()].map(([t,o])=>({category:t,options:o}))}const G=()=>M(),j=()=>W();function h(r){const[e,l]=_(r,["class","classList","placeholder","options","current","value","label","groupBy","onSelect","onHighlight","onOpenChange","children","appearance","invalid","numeric","disabled","valueClass","placement","gutter","sameWidth","flip","slide","fitViewport"]),t=()=>(e.appearance??"base")==="inline",o={},v=()=>{o.cleanup?.(),o.cleanup=void 0,o.key=void 0},w=n=>e.value?e.value(n):L(n),V=n=>e.label?e.label(n):L(n),y=n=>{if(!e.onHighlight)return;if(!n){v();return}const m=w(n);o.key!==m&&(o.cleanup?.(),o.cleanup=e.onHighlight(n),o.key=m)};I(v);const P=$(()=>T(e.options,e.groupBy));return a(i,k(l,{multiple:!1,get disabled(){return e.disabled},"data-component":"select-v2-root",get placement(){return e.placement??(t()?"bottom-end":"bottom-start")},get gutter(){return e.gutter??4},get sameWidth(){return e.sameWidth??!t()},get flip(){return e.flip??!0},get slide(){return e.slide??!0},get fitViewport(){return e.fitViewport??!1},get value(){return e.current},get options(){return P()},optionValue:w,optionTextValue:V,optionGroupChildren:"options",get placeholder(){return e.placeholder},sectionComponent:n=>a(i.Section,{get children(){return a(O,{get when(){return n.section.rawValue.category},get children(){var m=H();return x(m,()=>n.section.rawValue.category),m}})}}),itemComponent:n=>a(i.Item,k(n,{"data-component":"menu-v2-item",onPointerEnter:()=>y(n.item.rawValue),onPointerMove:()=>y(n.item.rawValue),onFocus:()=>y(n.item.rawValue),get children(){return[a(i.ItemLabel,{"data-slot":"menu-v2-item-content",as:"span",get children(){return B(()=>!!e.children)()?e.children(n.item.rawValue):V(n.item.rawValue)}}),a(i.ItemIndicator,{"data-slot":"menu-v2-item-indicator",forceMount:!0,get children(){return a(j,{})}})]}})),onChange:n=>{e.onSelect?.(n??null),v()},onOpenChange:n=>{e.onOpenChange?.(n),n||v()},classList:{"ui-select-v2-root":!0},get children(){return[a(i.Trigger,{as:"div","data-component":"select-v2",get"data-appearance"(){return e.appearance??"base"},get"data-invalid"(){return e.invalid?"":void 0},get"data-numeric"(){return e.numeric?"":void 0},get disabled(){return e.disabled},get"data-disabled"(){return e.disabled?"":void 0},get classList(){return{"ui-select-v2":!0,...e.classList,[e.class??""]:!!e.class}},get children(){return[(()=>{var n=A();return x(n,a(i.Value,{"data-slot":"select-v2-value-text",get class(){return e.valueClass},classList:{"ui-select-v2-value-text":!0},children:m=>{const F=m.selectedOption();return F==null?"":V(F)}})),n})(),(()=>{var n=D();return x(n,a(G,{})),n})()]}}),a(i.Portal,{get children(){return a(i.Content,{"data-component":"menu-v2-content","data-slot":"select-v2-content",get children(){return a(i.Listbox,{"data-slot":"select-v2-listbox"})}})}})]}}))}var E=f("<div style=width:280px>");const S=["Apple","Banana","Cherry","Date","Elderberry"],K=[{city:"Boston",region:"North"},{city:"Miami",region:"South"},{city:"Atlanta",region:"South"},{city:"Seattle",region:"West"},{city:"Denver",region:"West"}],N="### Overview\nSingle-select built on Kobalte with a **TextInput v2** trigger surface and **Menu v2** list styling.\n\n### API\n- `placeholder`: Shown in the trigger when nothing is selected (same idea as text inputs).\n- `options`, `current`, `onSelect`: controlled selection (`current` is the selected option object).\n- `value` / `label`: accessors when options are not plain strings.\n- `groupBy`: groups options; section headers use menu group label styling.\n- `appearance`: `base` (28px), `large` (32px), or `inline` (compact settings-row trigger).\n- `placement`, `gutter`, `sameWidth`, `flip`, `slide`, `fitViewport`: forwarded to Kobalte popper (defaults match legacy `Select`: gutter 4, flip/slide on; inline uses `bottom-end` and `sameWidth: false`).\n- `invalid`, `disabled`, `numeric`: match text input conventions.\n",te={title:"UI V2/Select",id:"components-select-v2",component:h,tags:["autodocs"],parameters:{frameHeight:"420px",frameBackground:"#fff",docs:{description:{component:N}}},args:{placeholder:"Pick a fruit",invalid:!1,disabled:!1,appearance:"base"},argTypes:{placeholder:{control:"text"},invalid:{control:"boolean"},disabled:{control:"boolean"},appearance:{control:"select",options:["base","large","inline"]}}},s={render:r=>{const[e,l]=b(void 0);return a(h,{get placeholder(){return r.placeholder},get invalid(){return r.invalid},get disabled(){return r.disabled},get appearance(){return r.appearance},options:S,get current(){return e()},onSelect:t=>l(t===null?void 0:t)})}},c={render:r=>{const[e,l]=b(void 0);return a(h,{get placeholder(){return r.placeholder},get invalid(){return r.invalid},get disabled(){return r.disabled},appearance:"large",options:S,get current(){return e()},onSelect:t=>l(t===null?void 0:t)})}},d={render:r=>{const[e,l]=b(void 0);return a(h,{get placeholder(){return r.placeholder},get invalid(){return r.invalid},get disabled(){return r.disabled},get appearance(){return r.appearance},options:K,get current(){return e()},onSelect:t=>l(t===null?void 0:t),value:t=>t.city,label:t=>t.city,groupBy:t=>t.region})}},u={render:r=>{const[e,l]=b(void 0);return a(h,{get placeholder(){return r.placeholder},invalid:!0,get disabled(){return r.disabled},get appearance(){return r.appearance},options:S,get current(){return e()},onSelect:t=>l(t===null?void 0:t)})}},p={render:r=>a(h,{get placeholder(){return r.placeholder},get invalid(){return r.invalid},disabled:!0,get appearance(){return r.appearance},options:S,current:"Cherry",onSelect:()=>{}})},g={parameters:{frameHeight:"500px"},render:r=>{const[e,l]=b(void 0);return(()=>{var t=E();return x(t,a(C,{get children(){return[a(C.Label,{tooltip:"Choose one of the available options.",children:"Fruit"}),a(C.Prefix,{children:"Optional helper"}),a(h,{get placeholder(){return r.placeholder},get invalid(){return r.invalid},get disabled(){return r.disabled},get appearance(){return r.appearance},options:S,get current(){return e()},onSelect:o=>l(o===null?void 0:o)}),a(C.Suffix,{children:"After selection"})]}})),t})()}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Playground = () => {
  const [current, setCurrent] = createSignal(undefined);

  return (
    <SelectV2
      placeholder="Pick a fruit"
      invalid={false}
      disabled={false}
      appearance="base"
      options={fruits}
      current={current()}
      onSelect={(v) => setCurrent(v === null ? undefined : v)}
    />
  );
};
`,...s.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Large = () => {
  const [current, setCurrent] = createSignal(undefined);

  return (
    <SelectV2
      placeholder="Pick a fruit"
      invalid={false}
      disabled={false}
      appearance="large"
      options={fruits}
      current={current()}
      onSelect={(v) => setCurrent(v === null ? undefined : v)}
    />
  );
};
`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Grouped = () => {
  const [current, setCurrent] = createSignal(undefined);

  return (
    <SelectV2
      placeholder="Pick a fruit"
      invalid={false}
      disabled={false}
      appearance="base"
      options={cities}
      current={current()}
      onSelect={(v) => setCurrent(v === null ? undefined : v)}
      value={(x) => x.city}
      label={(x) => x.city}
      groupBy={(x) => x.region}
    />
  );
};
`,...d.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const Invalid = () => {
  const [current, setCurrent] = createSignal(undefined);

  return (
    <SelectV2
      placeholder="Pick a fruit"
      invalid
      disabled={false}
      appearance="base"
      options={fruits}
      current={current()}
      onSelect={(v) => setCurrent(v === null ? undefined : v)}
    />
  );
};
`,...u.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Disabled = () => (
  <SelectV2
    placeholder="Pick a fruit"
    invalid={false}
    disabled
    appearance="base"
    options={fruits}
    current="Cherry"
    onSelect={() => {}}
  />
);
`,...p.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{code:`const Field = () => {
  const [current, setCurrent] = createSignal(undefined);

  return (
    <div style={{ width: "280px" }}>
      <FieldV2>
        <FieldV2.Label tooltip="Choose one of the available options.">
          Fruit
        </FieldV2.Label>
        <FieldV2.Prefix>Optional helper</FieldV2.Prefix>
        <SelectV2
          placeholder="Pick a fruit"
          invalid={false}
          disabled={false}
          appearance="base"
          options={fruits}
          current={current()}
          onSelect={(v) => setCurrent(v === null ? undefined : v)}
        />
        <FieldV2.Suffix>After selection</FieldV2.Suffix>
      </FieldV2>
    </div>
  );
};
`,...g.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: args => {
    const [current, setCurrent] = createSignal(undefined);
    return <SelectV2 placeholder={args.placeholder} invalid={args.invalid} disabled={args.disabled} appearance={args.appearance} options={fruits} current={current()} onSelect={v => setCurrent(v === null ? undefined : v)} />;
  }
}`,...s.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: args => {
    const [current, setCurrent] = createSignal(undefined);
    return <SelectV2 placeholder={args.placeholder} invalid={args.invalid} disabled={args.disabled} appearance="large" options={fruits} current={current()} onSelect={v => setCurrent(v === null ? undefined : v)} />;
  }
}`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: args => {
    const [current, setCurrent] = createSignal(undefined);
    return <SelectV2<(typeof cities)[0]> placeholder={args.placeholder} invalid={args.invalid} disabled={args.disabled} appearance={args.appearance} options={cities} current={current()} onSelect={v => setCurrent(v === null ? undefined : v)} value={x => x.city} label={x => x.city} groupBy={x => x.region} />;
  }
}`,...d.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: args => {
    const [current, setCurrent] = createSignal(undefined);
    return <SelectV2 placeholder={args.placeholder} invalid disabled={args.disabled} appearance={args.appearance} options={fruits} current={current()} onSelect={v => setCurrent(v === null ? undefined : v)} />;
  }
}`,...u.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: args => <SelectV2 placeholder={args.placeholder} invalid={args.invalid} disabled appearance={args.appearance} options={fruits} current="Cherry" onSelect={() => {}} />
}`,...p.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{originalSource:`{
  parameters: {
    frameHeight: "500px"
  },
  render: args => {
    const [current, setCurrent] = createSignal(undefined);
    return <div style={{
      width: "280px"
    }}>
        <FieldV2>
          <FieldV2.Label tooltip="Choose one of the available options.">Fruit</FieldV2.Label>
          <FieldV2.Prefix>Optional helper</FieldV2.Prefix>
          <SelectV2 placeholder={args.placeholder} invalid={args.invalid} disabled={args.disabled} appearance={args.appearance} options={fruits} current={current()} onSelect={v => setCurrent(v === null ? undefined : v)} />
          <FieldV2.Suffix>After selection</FieldV2.Suffix>
        </FieldV2>
      </div>;
  }
}`,...g.parameters?.docs?.source}}};const ae=["Playground","Large","Grouped","Invalid","Disabled","Field"];export{p as Disabled,g as Field,d as Grouped,u as Invalid,c as Large,s as Playground,ae as __namedExportsOrder,te as default};
