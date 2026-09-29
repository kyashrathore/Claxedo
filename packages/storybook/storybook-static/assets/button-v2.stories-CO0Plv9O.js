import{i as t,b as e,t as c}from"./iframe-D288tw9h.js";import{B as a}from"./button-v2-DbG8OeJh.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var p=c("<div style=display:flex;gap:12px;align-items:center;flex-wrap:wrap>"),f=c("<div style=display:grid;gap:12px>"),h=c("<div style=display:grid;gap:8px><div style=font-size:12px;color:var(--text-weak);text-transform:capitalize></div><div style=display:flex;gap:8px;flex-wrap:wrap>");const y=`### Overview
Button v2 with visual variants and three sizes.

### API
- \`variant\`: "neutral" | "danger" | "warning" | "contrast" | "ghost" | "ghost-muted" | "loading".
- \`size\`: "small" | "normal" | "large".
- \`icon\`: Optional icon name.
- Inherits Kobalte Button props and native button attributes.

### States
- default, hover, pressed, focus, disabled.
- State selectors are available via pseudo-classes and \`[data-state]\`.
`,$={title:"UI V2/Button",id:"components-button-v2",component:a,tags:["autodocs"],parameters:{frameHeight:"240px",frameBackground:"#fff",docs:{description:{component:y}}},args:{children:"Button",variant:"neutral",size:"normal"},argTypes:{icon:{control:"text"},variant:{control:"select",options:["neutral","danger","warning","contrast","ghost","ghost-muted","loading"]},size:{control:"select",options:["normal","large"]}}},r={},s={render:()=>(()=>{var n=p();return t(n,e(a,{variant:"neutral",children:"Neutral"}),null),t(n,e(a,{variant:"danger",children:"Danger"}),null),t(n,e(a,{variant:"warning",children:"Warning"}),null),t(n,e(a,{variant:"contrast",children:"Contrast"}),null),t(n,e(a,{variant:"ghost",children:"Ghost"}),null),t(n,e(a,{variant:"ghost-muted",icon:"edit",children:"Ghost muted"}),null),t(n,e(a,{variant:"loading",children:"Loading"}),null),n})()},o={render:()=>(()=>{var n=p();return t(n,e(a,{size:"small",variant:"neutral",children:"Small"}),null),t(n,e(a,{size:"normal",variant:"neutral",children:"Normal"}),null),t(n,e(a,{size:"large",variant:"neutral",children:"Large"}),null),n})()},i={render:()=>(()=>{var n=p();return t(n,e(a,{variant:"neutral",size:"normal",icon:"plus",children:"Normal"}),null),t(n,e(a,{variant:"contrast",size:"large",icon:"plus",children:"Large"}),null),n})()},l={render:()=>{const n=["neutral","danger","warning","contrast","ghost","ghost-muted","loading"],B=["default","hover","pressed","focus","disabled"],V=d=>d.charAt(0).toUpperCase()+d.slice(1);return(()=>{var d=f();return t(d,()=>n.map(v=>(()=>{var m=h(),g=m.firstChild,x=g.nextSibling;return t(g,v),t(x,()=>B.map(u=>e(a,{variant:v,"data-state":u==="default"?void 0:u,disabled:u==="disabled",get children(){return V(u)}}))),m})())),d})()}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Playground = () => (
  <ButtonV2 variant="neutral" size="normal">
    Button
  </ButtonV2>
);
`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Variants = () => (
  <div
    style={{
      display: "flex",
      gap: "12px",
      "align-items": "center",
      "flex-wrap": "wrap",
    }}
  >
    <ButtonV2 variant="neutral">Neutral</ButtonV2>
    <ButtonV2 variant="danger">Danger</ButtonV2>
    <ButtonV2 variant="warning">Warning</ButtonV2>
    <ButtonV2 variant="contrast">Contrast</ButtonV2>
    <ButtonV2 variant="ghost">Ghost</ButtonV2>
    <ButtonV2 variant="ghost-muted" icon="edit">
      Ghost muted
    </ButtonV2>
    <ButtonV2 variant="loading">Loading</ButtonV2>
  </div>
);
`,...s.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Sizes = () => (
  <div
    style={{
      display: "flex",
      gap: "12px",
      "align-items": "center",
      "flex-wrap": "wrap",
    }}
  >
    <ButtonV2 size="small" variant="neutral">
      Small
    </ButtonV2>
    <ButtonV2 size="normal" variant="neutral">
      Normal
    </ButtonV2>
    <ButtonV2 size="large" variant="neutral">
      Large
    </ButtonV2>
  </div>
);
`,...o.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Icon = () => (
  <div
    style={{
      display: "flex",
      gap: "12px",
      "align-items": "center",
      "flex-wrap": "wrap",
    }}
  >
    <ButtonV2 variant="neutral" size="normal" icon="plus">
      Normal
    </ButtonV2>
    <ButtonV2 variant="contrast" size="large" icon="plus">
      Large
    </ButtonV2>
  </div>
);
`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const AllStates = () => {
  const variants = [
    "neutral",
    "danger",
    "warning",
    "contrast",
    "ghost",
    "ghost-muted",
    "loading",
  ] as const;
  const states = ["default", "hover", "pressed", "focus", "disabled"] as const;
  const toTitleCase = (value: string) =>
    value.charAt(0).toUpperCase() + value.slice(1);
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      {variants.map((variant) => (
        <div style={{ display: "grid", gap: "8px" }}>
          <div
            style={{
              "font-size": "12px",
              color: "var(--text-weak)",
              "text-transform": "capitalize",
            }}
          >
            {variant}
          </div>
          <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
            {states.map((state) => (
              <ButtonV2
                variant={variant}
                data-state={state === "default" ? undefined : state}
                disabled={state === "disabled"}
              >
                {toTitleCase(state)}
              </ButtonV2>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
`,...l.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:"{}",...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center",
    "flex-wrap": "wrap"
  }}>
      <ButtonV2 variant="neutral">Neutral</ButtonV2>
      <ButtonV2 variant="danger">Danger</ButtonV2>
      <ButtonV2 variant="warning">Warning</ButtonV2>
      <ButtonV2 variant="contrast">Contrast</ButtonV2>
      <ButtonV2 variant="ghost">Ghost</ButtonV2>
      <ButtonV2 variant="ghost-muted" icon="edit">
        Ghost muted
      </ButtonV2>
      <ButtonV2 variant="loading">Loading</ButtonV2>
    </div>
}`,...s.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center",
    "flex-wrap": "wrap"
  }}>
      <ButtonV2 size="small" variant="neutral">
        Small
      </ButtonV2>
      <ButtonV2 size="normal" variant="neutral">
        Normal
      </ButtonV2>
      <ButtonV2 size="large" variant="neutral">
        Large
      </ButtonV2>
    </div>
}`,...o.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center",
    "flex-wrap": "wrap"
  }}>
      <ButtonV2 variant="neutral" size="normal" icon="plus">
        Normal
      </ButtonV2>
      <ButtonV2 variant="contrast" size="large" icon="plus">
        Large
      </ButtonV2>
    </div>
}`,...i.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => {
    const variants = ["neutral", "danger", "warning", "contrast", "ghost", "ghost-muted", "loading"] as const;
    const states = ["default", "hover", "pressed", "focus", "disabled"] as const;
    const toTitleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
    return <div style={{
      display: "grid",
      gap: "12px"
    }}>
        {variants.map(variant => <div style={{
        display: "grid",
        gap: "8px"
      }}>
            <div style={{
          "font-size": "12px",
          color: "var(--text-weak)",
          "text-transform": "capitalize"
        }}>
              {variant}
            </div>
            <div style={{
          display: "flex",
          gap: "8px",
          "flex-wrap": "wrap"
        }}>
              {states.map(state => <ButtonV2 variant={variant} data-state={state === "default" ? undefined : state} disabled={state === "disabled"}>
                  {toTitleCase(state)}
                </ButtonV2>)}
            </div>
          </div>)}
      </div>;
  }
}`,...l.parameters?.docs?.source}}};const L=["Playground","Variants","Sizes","Icon","AllStates"];export{l as AllStates,i as Icon,r as Playground,o as Sizes,s as Variants,L as __namedExportsOrder,$ as default};
