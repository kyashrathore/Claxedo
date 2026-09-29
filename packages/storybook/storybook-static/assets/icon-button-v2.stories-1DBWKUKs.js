import{i as a,b as i,t as c}from"./iframe-D288tw9h.js";import{I as o}from"./icon-button-v2-DZNf4L9M.js";import"./preload-helper-D9Z9MdNV.js";var m=c("<div style=display:flex;gap:12px;align-items:center;flex-wrap:wrap>"),x=c("<div style=display:grid;gap:12px>"),y=c("<div style=display:grid;gap:8px><div style=font-size:12px;color:var(--text-weak);text-transform:capitalize></div><div style=display:flex;gap:8px;flex-wrap:wrap>");const z=`### Overview
Square icon-only button v2 with three visual variants and three sizes.

### API
- \`icon\`: Icon name from the icon component.
- \`variant\`: "neutral" | "contrast" | "ghost".
- \`size\`: "small" | "normal" | "large".
- \`iconSize\`: Optional explicit icon size override.
- Inherits Kobalte Button props and native button attributes.

### States
- default, hover, pressed, focus, disabled.
- State selectors are available via pseudo-classes and \`[data-state]\`.
`,B={title:"UI V2/IconButton",id:"components-icon-button-v2",component:o,tags:["autodocs"],parameters:{frameHeight:"300px",frameBackground:"#fff",docs:{description:{component:z}}},args:{icon:"plus",variant:"neutral",size:"normal"},argTypes:{icon:{control:"text"},variant:{control:"select",options:["neutral","contrast","ghost"]},size:{control:"select",options:["small","normal","large"]},iconSize:{control:"select",options:["small","normal","large"]}}},t={},e={render:()=>(()=>{var n=m();return a(n,i(o,{icon:"plus",variant:"neutral"}),null),a(n,i(o,{icon:"plus",variant:"contrast"}),null),a(n,i(o,{icon:"plus",variant:"ghost"}),null),n})()},s={render:()=>(()=>{var n=m();return a(n,i(o,{icon:"plus",size:"small",variant:"neutral"}),null),a(n,i(o,{icon:"plus",size:"normal",variant:"neutral"}),null),a(n,i(o,{icon:"plus",size:"large",variant:"neutral"}),null),n})()},r={render:()=>{const n=["neutral","contrast","ghost"],g=["default","hover","pressed","focus","disabled"];return(()=>{var p=x();return a(p,()=>n.map(d=>(()=>{var u=y(),v=u.firstChild,f=v.nextSibling;return a(v,d),a(f,()=>g.map(l=>i(o,{icon:"plus",variant:d,"data-state":l==="default"?void 0:l,disabled:l==="disabled"}))),u})())),p})()}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Playground = () => (
  <IconButtonV2 icon="plus" variant="neutral" size="normal" />
);
`,...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Variants = () => (
  <div
    style={{
      display: "flex",
      gap: "12px",
      "align-items": "center",
      "flex-wrap": "wrap",
    }}
  >
    <IconButtonV2 icon="plus" variant="neutral" />
    <IconButtonV2 icon="plus" variant="contrast" />
    <IconButtonV2 icon="plus" variant="ghost" />
  </div>
);
`,...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Sizes = () => (
  <div
    style={{
      display: "flex",
      gap: "12px",
      "align-items": "center",
      "flex-wrap": "wrap",
    }}
  >
    <IconButtonV2 icon="plus" size="small" variant="neutral" />
    <IconButtonV2 icon="plus" size="normal" variant="neutral" />
    <IconButtonV2 icon="plus" size="large" variant="neutral" />
  </div>
);
`,...s.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const AllStates = () => {
  const variants = ["neutral", "contrast", "ghost"] as const;
  const states = ["default", "hover", "pressed", "focus", "disabled"] as const;

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
              <IconButtonV2
                icon="plus"
                variant={variant}
                data-state={state === "default" ? undefined : state}
                disabled={state === "disabled"}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:"{}",...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center",
    "flex-wrap": "wrap"
  }}>
      <IconButtonV2 icon="plus" variant="neutral" />
      <IconButtonV2 icon="plus" variant="contrast" />
      <IconButtonV2 icon="plus" variant="ghost" />
    </div>
}`,...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px",
    "align-items": "center",
    "flex-wrap": "wrap"
  }}>
      <IconButtonV2 icon="plus" size="small" variant="neutral" />
      <IconButtonV2 icon="plus" size="normal" variant="neutral" />
      <IconButtonV2 icon="plus" size="large" variant="neutral" />
    </div>
}`,...s.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => {
    const variants = ["neutral", "contrast", "ghost"] as const;
    const states = ["default", "hover", "pressed", "focus", "disabled"] as const;
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
              {states.map(state => <IconButtonV2 icon="plus" variant={variant} data-state={state === "default" ? undefined : state} disabled={state === "disabled"} />)}
            </div>
          </div>)}
      </div>;
  }
}`,...r.parameters?.docs?.source}}};const h=["Playground","Variants","Sizes","AllStates"];export{r as AllStates,t as Playground,s as Sizes,e as Variants,h as __namedExportsOrder,B as default};
