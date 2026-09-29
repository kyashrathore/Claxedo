import{r as y,m as w,s as k,c as D,b as t,l as F,ad as P,I as O,i as C,t as x,j as E,x as K}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var N=x("<div>"),R=x("<button><span data-slot=segmented-control-v2-item-label>");const z=F();function q(){const e=E(z);if(!e)throw new Error("SegmentedControlItemV2 must be used inside SegmentedControlV2");return e}function V(e){const s=y(()=>Object.hasOwn(e,"value")),n=w({allowDeselect:!1,disabled:!1},e),[l,d]=k(n,["class","classList","children","value","defaultValue","onChange","allowDeselect","disabled","ref"]),[f,S]=D(l.defaultValue??null),b=y(()=>s()?l.value??null:f()),I=a=>{s()||S(a),l.onChange?.(a)},p={selected:b,groupDisabled:()=>l.disabled,select:a=>{I(a)},clearIfAllowed:a=>{!l.allowDeselect||b()!==a||I(null)},focusNext:(a,h)=>{const _=a.closest('[data-slot="segmented-control-v2"]');if(!_)return;const $=Array.from(_.querySelectorAll('button[data-slot="segmented-control-v2-item"]')).filter(j=>!j.disabled),W=$.indexOf(a);$[W+h]?.focus()}},A=a=>{const h=l.ref;typeof h=="function"&&h(a)};return t(z.Provider,{value:p,get children(){var a=N();return P(A,a),O(a,w(d,{role:"group","data-component":"segmented-control-v2","data-slot":"segmented-control-v2",get classList(){return{"ui-segmented-control-v2":!0,...l.classList,[l.class??""]:!!l.class}}}),!1,!0),C(a,()=>l.children),a}})}function B(e,s){e&&(typeof e=="function"?e(s):e[0](e[1],s))}function r(e){const s=w({disabled:!1},e),[n,l]=k(s,["class","classList","children","value","disabled","onClick","onKeyDown"]),d=q(),f=y(()=>d.selected()===n.value),S=y(()=>d.groupDisabled()||n.disabled),b=o=>{B(n.onClick,o),!(o.defaultPrevented||S())&&(f()?d.clearIfAllowed(n.value):d.select(n.value))},I=o=>{if(B(n.onKeyDown,o),o.defaultPrevented||S())return;const v=o.currentTarget;if(o.key==="ArrowRight")o.preventDefault(),d.focusNext(v,1);else if(o.key==="ArrowLeft")o.preventDefault(),d.focusNext(v,-1);else if(o.key==="Home")o.preventDefault(),v.closest('[data-slot="segmented-control-v2"]')?.querySelector('button[data-slot="segmented-control-v2-item"]:not(:disabled)')?.focus();else if(o.key==="End"){o.preventDefault();const p=v.closest('[data-slot="segmented-control-v2"]')?.querySelectorAll('button[data-slot="segmented-control-v2-item"]:not(:disabled)');p?.[p.length-1]?.focus()}};return(()=>{var o=R(),v=o.firstChild;return O(o,w(l,{type:"button","data-slot":"segmented-control-v2-item",get"data-pressed"(){return f()?"":void 0},get"aria-pressed"(){return f()},get disabled(){return S()},get classList(){return{"ui-segmented-control-v2-item":!0,...n.classList,[n.class??""]:!!n.class}},onClick:b,onKeyDown:I}),!1,!0),C(v,()=>n.children),o})()}var T=x("<div style=display:grid;gap:12px;justify-items:start><div style=font-family:var(--v2-font-family-sans);font-size:12px;color:#808080>Value: "),G=x("<div style=width:320px>");const H='### Overview\nSingle-select segmented control with **custom state** and native `<button type="button">` segments.\n\n### Accessibility (toggle group style)\n- Root: `role="group"` — pass `aria-label` or `aria-labelledby` (standard div attributes).\n- Segments: `aria-pressed` reflects selection; `data-pressed` is set for styling.\n- **Arrow Left / Right** move focus between enabled segments; **Home** / **End** focus first / last enabled segment.\n\n### API\n- **SegmentedControlV2:** `value?`, `defaultValue?`, `onChange?(value: string | null)`, `allowDeselect?` (default `false`), `disabled?`, plus native div attributes (`class`, `aria-*`, `ref`, etc.).\n- **SegmentedControlItemV2:** `value` (string), `disabled?`, `children` (label), plus other button attributes except `type`.\n\n### Behavior\n- With default `allowDeselect={false}`, clicking the active segment does nothing; selection is never cleared.\n- With `allowDeselect`, clicking the active segment clears selection and `onChange(null)` runs.\n\n### Theming\n- `data-slot="segmented-control-v2"` on the track; items use `data-slot="segmented-control-v2-item"` and `data-pressed` when selected.\n',Q={title:"UI V2/SegmentedControl",id:"components-segmented-control-v2",component:V,tags:["autodocs"],parameters:{docs:{description:{component:H}}}},m={render:()=>t(V,{defaultValue:"a","aria-label":"Demo segment control",get children(){return[t(r,{value:"a",children:"Label"}),t(r,{value:"b",children:"Label"}),t(r,{value:"c",children:"Label"}),t(r,{value:"d",children:"Label"})]}})},i={render:()=>{const[e,s]=D("b");return(()=>{var n=T(),l=n.firstChild;return l.firstChild,C(n,t(V,{get value(){return e()},onChange:s,"aria-label":"View mode",get children(){return[t(r,{value:"a",children:"List"}),t(r,{value:"b",children:"Grid"}),t(r,{value:"c",children:"Board"})]}}),l),C(l,e,null),n})()}},c={render:()=>{const[e,s]=D("a");return(()=>{var n=T(),l=n.firstChild;return l.firstChild,C(n,t(V,{get value(){return e()},allowDeselect:!0,onChange:s,"aria-label":"Optional selection",get children(){return[t(r,{value:"a",children:"A"}),t(r,{value:"b",children:"B"}),t(r,{value:"c",children:"C"})]}}),l),C(l,(()=>{var d=K(()=>e()===null);return()=>d()?"none":e()})(),null),n})()}},u={render:()=>t(V,{defaultValue:"a","aria-label":"Segments with one disabled",get children(){return[t(r,{value:"a",children:"One"}),t(r,{value:"b",disabled:!0,children:"Two"}),t(r,{value:"c",children:"Three"})]}})},g={render:()=>(()=>{var e=G();return C(e,t(V,{defaultValue:"x",class:"segmented-control-v2--full-width","aria-label":"Full width",get children(){return[t(r,{value:"x",children:"A"}),t(r,{value:"y",children:"B"}),t(r,{value:"z",children:"C"})]}})),e})()};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{code:`const Basic = () => (
  <SegmentedControlV2 defaultValue="a" aria-label="Demo segment control">
    <SegmentedControlItemV2 value="a">Label</SegmentedControlItemV2>
    <SegmentedControlItemV2 value="b">Label</SegmentedControlItemV2>
    <SegmentedControlItemV2 value="c">Label</SegmentedControlItemV2>
    <SegmentedControlItemV2 value="d">Label</SegmentedControlItemV2>
  </SegmentedControlV2>
);
`,...m.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Controlled = () => {
  const [value, setValue] = createSignal("b");
  return (
    <div style={{ display: "grid", gap: "12px", "justify-items": "start" }}>
      <SegmentedControlV2
        value={value()}
        onChange={setValue}
        aria-label="View mode"
      >
        <SegmentedControlItemV2 value="a">List</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="b">Grid</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="c">Board</SegmentedControlItemV2>
      </SegmentedControlV2>
      <div
        style={{
          "font-family": "var(--v2-font-family-sans)",
          "font-size": "12px",
          color: "#808080",
        }}
      >
        Value: {value()}
      </div>
    </div>
  );
};
`,...i.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const AllowDeselect = () => {
  const [value, setValue] = createSignal<string | null>("a");
  return (
    <div style={{ display: "grid", gap: "12px", "justify-items": "start" }}>
      <SegmentedControlV2
        value={value()}
        allowDeselect
        onChange={setValue}
        aria-label="Optional selection"
      >
        <SegmentedControlItemV2 value="a">A</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="b">B</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="c">C</SegmentedControlItemV2>
      </SegmentedControlV2>
      <div
        style={{
          "font-family": "var(--v2-font-family-sans)",
          "font-size": "12px",
          color: "#808080",
        }}
      >
        Value: {value() === null ? "none" : value()}
      </div>
    </div>
  );
};
`,...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const WithDisabledItem = () => (
  <SegmentedControlV2 defaultValue="a" aria-label="Segments with one disabled">
    <SegmentedControlItemV2 value="a">One</SegmentedControlItemV2>
    <SegmentedControlItemV2 value="b" disabled>
      Two
    </SegmentedControlItemV2>
    <SegmentedControlItemV2 value="c">Three</SegmentedControlItemV2>
  </SegmentedControlV2>
);
`,...u.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{code:`const FullWidth = () => (
  <div style={{ width: "320px" }}>
    <SegmentedControlV2
      defaultValue="x"
      class="segmented-control-v2--full-width"
      aria-label="Full width"
    >
      <SegmentedControlItemV2 value="x">A</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="y">B</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="z">C</SegmentedControlItemV2>
    </SegmentedControlV2>
  </div>
);
`,...g.parameters?.docs?.source}}};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{originalSource:`{
  render: () => <SegmentedControlV2 defaultValue="a" aria-label="Demo segment control">
      <SegmentedControlItemV2 value="a">Label</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="b">Label</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="c">Label</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="d">Label</SegmentedControlItemV2>
    </SegmentedControlV2>
}`,...m.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("b");
    return <div style={{
      display: "grid",
      gap: "12px",
      "justify-items": "start"
    }}>
        <SegmentedControlV2 value={value()} onChange={setValue} aria-label="View mode">
          <SegmentedControlItemV2 value="a">List</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="b">Grid</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="c">Board</SegmentedControlItemV2>
        </SegmentedControlV2>
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "#808080"
      }}>
          Value: {value()}
        </div>
      </div>;
  }
}`,...i.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal<string | null>("a");
    return <div style={{
      display: "grid",
      gap: "12px",
      "justify-items": "start"
    }}>
        <SegmentedControlV2 value={value()} allowDeselect onChange={setValue} aria-label="Optional selection">
          <SegmentedControlItemV2 value="a">A</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="b">B</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="c">C</SegmentedControlItemV2>
        </SegmentedControlV2>
        <div style={{
        "font-family": "var(--v2-font-family-sans)",
        "font-size": "12px",
        color: "#808080"
      }}>
          Value: {value() === null ? "none" : value()}
        </div>
      </div>;
  }
}`,...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => <SegmentedControlV2 defaultValue="a" aria-label="Segments with one disabled">
      <SegmentedControlItemV2 value="a">One</SegmentedControlItemV2>
      <SegmentedControlItemV2 value="b" disabled>
        Two
      </SegmentedControlItemV2>
      <SegmentedControlItemV2 value="c">Three</SegmentedControlItemV2>
    </SegmentedControlV2>
}`,...u.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "320px"
  }}>
      <SegmentedControlV2 defaultValue="x" class="segmented-control-v2--full-width" aria-label="Full width">
        <SegmentedControlItemV2 value="x">A</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="y">B</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="z">C</SegmentedControlItemV2>
      </SegmentedControlV2>
    </div>
}`,...g.parameters?.docs?.source}}};const X=["Basic","Controlled","AllowDeselect","WithDisabledItem","FullWidth"];export{c as AllowDeselect,m as Basic,i as Controlled,g as FullWidth,u as WithDisabledItem,X as __namedExportsOrder,Q as default};
