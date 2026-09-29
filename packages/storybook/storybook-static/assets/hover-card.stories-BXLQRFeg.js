import{s as u,b as o,m,i as c,t as a,c as g,ad as h}from"./iframe-D288tw9h.js";import{H as i}from"./WDUYIXAX-BmhfwJI2.js";import"./preload-helper-D9Z9MdNV.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";var f=a("<div data-slot=hover-card-body>");function l(n){const[e,s]=u(n,["trigger","mount","class","classList","children"]);return o(i,m({gutter:4},s,{get children(){return[o(i.Trigger,{as:"div","data-slot":"hover-card-trigger",tabIndex:-1,get children(){return e.trigger}}),o(i.Portal,{get mount(){return e.mount},get children(){return o(i.Content,{"data-component":"hover-card-content",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){var d=f();return c(d,()=>e.children),d}})}})]}}))}var x=a("<div style=display:grid;gap:6px><div style=font-weight:600>Preview</div><div style=color:var(--text-weak);font-size:12px>Short supporting text."),v=a("<span style=text-decoration:underline;cursor:default>Hover me"),y=a("<div style=display:grid;gap:6px><div style=font-weight:600>Mounted inside</div><div style=color:var(--text-weak);font-size:12px>Uses custom mount node."),w=a('<div style="padding:16px;border:1px dashed var(--border-weak)">');const H=`### Overview
Hover-triggered card for lightweight previews and metadata.

Use for short summaries; avoid dense interactive controls.

### API
- Required: \`trigger\` element.
- Children render inside the hover card body.

### Variants and states
- None; content and trigger are fully composable.

### Behavior
- Opens on hover/focus over the trigger.

### Accessibility
- TODO: confirm focus and hover intent behavior from Kobalte.

### Theming/tokens
- Uses \`data-component="hover-card-content"\` and slots for styling.

`,k={title:"UI/HoverCard",id:"components-hover-card",component:l,tags:["autodocs"],parameters:{docs:{description:{component:H}}}},r={render:()=>o(l,{get trigger(){return v()},get children(){var n=x(),e=n.firstChild;return e.nextSibling,n}})},t={render:()=>{const[n,e]=g(void 0);return(()=>{var s=w();return h(e,s),c(s,o(l,{get mount(){return n()},get trigger(){return v()},get children(){var d=y(),p=d.firstChild;return p.nextSibling,d}})),s})()}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Basic = () => (
  <mod.HoverCard
    trigger={
      <span style={{ "text-decoration": "underline", cursor: "default" }}>
        Hover me
      </span>
    }
  >
    <div style={{ display: "grid", gap: "6px" }}>
      <div style={{ "font-weight": 600 }}>Preview</div>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Short supporting text.
      </div>
    </div>
  </mod.HoverCard>
);
`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const InlineMount = () => {
  const [mount, setMount] = createSignal<HTMLDivElement | undefined>(undefined);
  return (
    <div
      ref={setMount}
      style={{ padding: "16px", border: "1px dashed var(--border-weak)" }}
    >
      <mod.HoverCard
        mount={mount()}
        trigger={
          <span style={{ "text-decoration": "underline", cursor: "default" }}>
            Hover me
          </span>
        }
      >
        <div style={{ display: "grid", gap: "6px" }}>
          <div style={{ "font-weight": 600 }}>Mounted inside</div>
          <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
            Uses custom mount node.
          </div>
        </div>
      </mod.HoverCard>
    </div>
  );
};
`,...t.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <mod.HoverCard trigger={<span style={{
    "text-decoration": "underline",
    cursor: "default"
  }}>Hover me</span>}>
      <div style={{
      display: "grid",
      gap: "6px"
    }}>
        <div style={{
        "font-weight": 600
      }}>Preview</div>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Short supporting text.</div>
      </div>
    </mod.HoverCard>
}`,...r.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [mount, setMount] = createSignal<HTMLDivElement | undefined>(undefined);
    return <div ref={setMount} style={{
      padding: "16px",
      border: "1px dashed var(--border-weak)"
    }}>
        <mod.HoverCard mount={mount()} trigger={<span style={{
        "text-decoration": "underline",
        cursor: "default"
      }}>Hover me</span>}>
          <div style={{
          display: "grid",
          gap: "6px"
        }}>
            <div style={{
            "font-weight": 600
          }}>Mounted inside</div>
            <div style={{
            color: "var(--text-weak)",
            "font-size": "12px"
          }}>Uses custom mount node.</div>
          </div>
        </mod.HoverCard>
      </div>;
  }
}`,...t.parameters?.docs?.source}}};const S=["Basic","InlineMount"];export{r as Basic,t as InlineMount,S as __namedExportsOrder,k as default};
