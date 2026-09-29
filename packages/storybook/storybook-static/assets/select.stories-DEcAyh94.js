import{s as G,n as x,r as T,b as r,m as y,x as O,i as A,t as I}from"./iframe-D288tw9h.js";import{S as s,s as S}from"./select-item-CRcMIsHa.js";import{t as k,a as L,b as P,c as _}from"./map-B72Trknd.js";import{B as z}from"./button-Bsz0PTzb.js";import{I as C}from"./icon-BG5j3Qjr.js";import{c as D}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./AGCGV7T6-D4ycykph.js";import"./LP6E37CW-BgXoIsgV.js";import"./ZZYKR3VO-DWSPmSPl.js";import"./DAEKM6TG-BBrc5b-v.js";import"./OGE3DKII-BkPGJFio.js";import"./NGHEENNE-Dk4g74Tj.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";function b(a){const[e,B]=G(a,["class","triggerClass","contentClass","classList","placeholder","options","current","value","label","groupBy","valueClass","onSelect","onHighlight","onOpenChange","children","renderValue","triggerStyle","triggerVariant","triggerProps"]),d={key:void 0,cleanup:void 0},g=()=>{d.cleanup?.(),d.cleanup=void 0,d.key=void 0},v=t=>e.value?e.value(t):S(t),m=t=>e.label?e.label(t):S(t),h=t=>{if(!e.onHighlight)return;if(!t){g();return}const o=v(t);d.key!==o&&(d.cleanup?.(),d.cleanup=e.onHighlight(t),d.key=o)};x(g);const V=T(()=>k(e.options,_(o=>e.groupBy?e.groupBy(o):""),P(),L(([o,w])=>({category:o,options:w}))));return r(s,y(B,{"data-component":"select",get"data-trigger-style"(){return e.triggerVariant},get placement(){return e.triggerVariant==="settings"?"bottom-end":"bottom-start"},gutter:4,get value(){return e.current},get options(){return V()},optionValue:v,optionTextValue:m,optionGroupChildren:"options",get placeholder(){return e.placeholder},sectionComponent:t=>r(s.Section,{"data-slot":"select-section",class:"ui-select-section",get children(){return t.section.rawValue.category}}),itemComponent:t=>r(s.Item,y(t,{"data-slot":"select-select-item",get classList(){return{"ui-select-select-item":!0,...e.classList,[e.class??""]:!!e.class}},onPointerEnter:()=>h(t.item.rawValue),onPointerMove:()=>h(t.item.rawValue),onFocus:()=>h(t.item.rawValue),get children(){return[r(s.ItemLabel,{"data-slot":"select-select-item-label",class:"ui-select-select-item-label",get children(){return O(()=>!!e.children)()?e.children(t.item.rawValue):m(t.item.rawValue)}}),r(s.ItemIndicator,{"data-slot":"select-select-item-indicator",class:"ui-select-select-item-indicator",get children(){return r(C,{name:"check-small",size:"small"})}})]}})),onChange:t=>{e.onSelect?.(t??void 0),g()},onOpenChange:t=>{e.onOpenChange?.(t),t||g()},get children(){return[r(s.Trigger,y(()=>e.triggerProps,{get disabled(){return a.disabled},"data-slot":"select-select-trigger",as:z,get size(){return a.size},get variant(){return a.variant},get style(){return e.triggerStyle},get classList(){return{"ui-select-select-trigger":!0,...e.classList,[e.class??""]:!!e.class,[e.triggerClass??""]:!!e.triggerClass}},get children(){return[r(s.Value,{"data-slot":"select-select-trigger-value",get class(){return e.valueClass},classList:{"ui-select-select-trigger-value":!0},children:t=>{const o=t.selectedOption()??e.current;return o?e.renderValue?e.renderValue(o):m(o):e.placeholder||""}}),r(s.Icon,{"data-slot":"select-select-trigger-icon",class:"ui-select-select-trigger-icon",get children(){return r(C,{name:"chevron-down",size:"small"})}})]}})),r(s.Portal,{get children(){return r(s.Content,{get classList(){return{"ui-select-content":!0,...e.classList,[e.class??""]:!!e.class,[e.contentClass??""]:!!e.contentClass}},"data-component":"select-content",get"data-trigger-style"(){return e.triggerVariant},get children(){return r(s.Listbox,{"data-slot":"select-select-content-list",class:"ui-select-select-content-list"})}})}})]}}))}const j=Object.freeze(Object.defineProperty({__proto__:null,Select:b},Symbol.toStringTag,{value:"Module"}));var $=I("<span style=text-transform:uppercase>");const U='### Overview\nSelect menu for choosing a single option with optional grouping.\n\nUse `children` to customize option rendering.\n\n### API\n- Required: `options`.\n- Optional: `current`, `placeholder`, `value`, `label`, `groupBy`.\n- Accepts Button props for the trigger (`variant`, `size`).\n\n### Variants and states\n- Trigger supports "settings" style via `triggerVariant`.\n\n### Behavior\n- Uses Kobalte Select with optional item highlight callbacks.\n\n### Accessibility\n- TODO: confirm keyboard navigation and aria attributes from Kobalte.\n\n### Theming/tokens\n- Uses `data-component="select"` with slot attributes.\n\n',f=D({title:"UI/Select",mod:j,args:{options:["One","Two","Three"],current:"One",placeholder:"Choose...",variant:"secondary",size:"normal"}}),te={title:"UI/Select",id:"components-select",component:f.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:U}}},argTypes:{triggerVariant:{control:"select",options:["settings",void 0]}}},n=f.Basic,c={render:()=>{const a=[{id:"alpha",label:"Alpha",group:"Group A"},{id:"bravo",label:"Bravo",group:"Group A"},{id:"delta",label:"Delta",group:"Group B"}];return r(b,{options:a,get current(){return a[0]},value:e=>e.id,label:e=>e.label,groupBy:e=>e.group,placeholder:"Choose...",variant:"secondary"})}},i={args:{triggerVariant:"settings"}},l={render:()=>r(b,{options:["Primary","Secondary","Ghost"],current:"Primary",placeholder:"Choose...",variant:"secondary",children:a=>(()=>{var e=$();return A(e,a),e})()})},p={args:{triggerStyle:{"min-width":"180px","justify-content":"space-between"}}},u={args:{disabled:!0}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  59 | }
  60 |
> 61 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  62 |
  63 | export const Grouped = {
  64 |   render: () => {`,...n.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Grouped = () => {
  const options = [
    { id: "alpha", label: "Alpha", group: "Group A" },
    { id: "bravo", label: "Bravo", group: "Group A" },
    { id: "delta", label: "Delta", group: "Group B" },
  ];
  return (
    <mod.Select
      options={options}
      current={options[0]}
      value={(item) => item.id}
      label={(item) => item.label}
      groupBy={(item) => item.group}
      placeholder="Choose..."
      variant="secondary"
    />
  );
};
`,...c.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const SettingsTrigger = () => (
  <story.meta.component triggerVariant="settings" />
);
`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const CustomRender = () => (
  <mod.Select
    options={["Primary", "Secondary", "Ghost"]}
    current="Primary"
    placeholder="Choose..."
    variant="secondary"
  >
    {(item) => <span style={{ "text-transform": "uppercase" }}>{item}</span>}
  </mod.Select>
);
`,...l.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const CustomTriggerStyle = () => (
  <story.meta.component
    triggerStyle={{ "min-width": "180px", "justify-content": "space-between" }}
  />
);
`,...p.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const Disabled = () => <story.meta.component disabled />;
`,...u.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:"story.Basic",...n.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => {
    const options = [{
      id: "alpha",
      label: "Alpha",
      group: "Group A"
    }, {
      id: "bravo",
      label: "Bravo",
      group: "Group A"
    }, {
      id: "delta",
      label: "Delta",
      group: "Group B"
    }];
    return <mod.Select options={options} current={options[0]} value={item => item.id} label={item => item.label} groupBy={item => item.group} placeholder="Choose..." variant="secondary" />;
  }
}`,...c.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  args: {
    triggerVariant: "settings"
  }
}`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => <mod.Select options={["Primary", "Secondary", "Ghost"]} current="Primary" placeholder="Choose..." variant="secondary">
      {item => <span style={{
      "text-transform": "uppercase"
    }}>{item}</span>}
    </mod.Select>
}`,...l.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  args: {
    triggerStyle: {
      "min-width": "180px",
      "justify-content": "space-between"
    }
  }
}`,...p.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  args: {
    disabled: true
  }
}`,...u.parameters?.docs?.source}}};const re=["Basic","Grouped","SettingsTrigger","CustomRender","CustomTriggerStyle","Disabled"];export{n as Basic,l as CustomRender,p as CustomTriggerStyle,u as Disabled,c as Grouped,i as SettingsTrigger,re as __namedExportsOrder,te as default};
