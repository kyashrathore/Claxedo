import{c as u,i as c,b as g,t as b}from"./iframe-D288tw9h.js";import{m as f,B as k}from"./basic-tool-Bj_cFKt0.js";import{c as y}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./i18n-CW9P7x91.js";import"./collapsible-Du8zhFL1.js";import"./UGE6PPGT-C6B63Gso.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./text-shimmer-SJimTaBu.js";import"./is-motion-value-DTVMTkbm.js";var S=b("<div style=display:grid;gap:8px><div style=font-size:12px;color:var(--text-weak)>");const h=`### Overview
Expandable tool panel with a structured trigger and optional details.

Use structured triggers for consistent layout; custom triggers allowed.

### API
- Required: \`icon\` and \`trigger\` (structured or custom JSX).
- Optional: \`status\`, \`defaultOpen\`, \`forceOpen\`, \`defer\`, \`locked\`.

### Variants and states
- Pending/running status animates the title via TextShimmer.

### Behavior
- Uses Collapsible; can defer content rendering until open.
- Locked state prevents closing.

### Accessibility
- TODO: confirm trigger semantics and aria labeling.

### Theming/tokens
- Uses \`data-component="tool-trigger"\` and related slots.

`,l=y({title:"UI/Basic Tool",mod:f,args:{icon:"mcp",defaultOpen:!0,trigger:{title:"Basic Tool",subtitle:"Example subtitle",args:["--flag","value"]},children:"Details content"}}),_={title:"UI/Basic Tool",id:"components-basic-tool",component:l.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:h}}}},e=l.Basic,t={args:{status:"pending",trigger:{title:"Running tool",subtitle:"Working..."},children:"Progress details"}},n={args:{locked:!0,trigger:{title:"Locked tool",subtitle:"Cannot close"},children:"Locked details"}},r={args:{defer:!0,defaultOpen:!1,trigger:{title:"Deferred tool",subtitle:"Content mounts on open"},children:"Deferred content"}},o={args:{forceOpen:!0,trigger:{title:"Forced open",subtitle:"Cannot close"},children:"Forced content"}},s={args:{hideDetails:!0,trigger:{title:"Summary only",subtitle:"Details hidden"},children:"Hidden content"}},a={render:()=>{const[d,p]=u("Subtitle not clicked");return(()=>{var i=S(),m=i.firstChild;return c(m,d),c(i,g(k,{icon:"mcp",trigger:{title:"Clickable subtitle",subtitle:"Click me"},onSubtitleClick:()=>p("Subtitle clicked"),children:"Subtitle action details"}),null),i})()}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  57 | }
  58 |
> 59 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  60 |
  61 | export const Pending = {
  62 |   args: {`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Pending = () => (
  <story.meta.component
    status="pending"
    trigger={{
      title: "Running tool",
      subtitle: "Working...",
    }}
  >
    Progress details
  </story.meta.component>
);
`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Locked = () => (
  <story.meta.component
    locked
    trigger={{
      title: "Locked tool",
      subtitle: "Cannot close",
    }}
  >
    Locked details
  </story.meta.component>
);
`,...n.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Deferred = () => (
  <story.meta.component
    defer
    defaultOpen={false}
    trigger={{
      title: "Deferred tool",
      subtitle: "Content mounts on open",
    }}
  >
    Deferred content
  </story.meta.component>
);
`,...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const ForceOpen = () => (
  <story.meta.component
    forceOpen
    trigger={{
      title: "Forced open",
      subtitle: "Cannot close",
    }}
  >
    Forced content
  </story.meta.component>
);
`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const HideDetails = () => (
  <story.meta.component
    hideDetails
    trigger={{
      title: "Summary only",
      subtitle: "Details hidden",
    }}
  >
    Hidden content
  </story.meta.component>
);
`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const SubtitleAction = () => {
  const [message, setMessage] = createSignal("Subtitle not clicked");
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ "font-size": "12px", color: "var(--text-weak)" }}>
        {message()}
      </div>
      <mod.BasicTool
        icon="mcp"
        trigger={{ title: "Clickable subtitle", subtitle: "Click me" }}
        onSubtitleClick={() => setMessage("Subtitle clicked")}
      >
        Subtitle action details
      </mod.BasicTool>
    </div>
  );
};
`,...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    status: "pending",
    trigger: {
      title: "Running tool",
      subtitle: "Working..."
    },
    children: "Progress details"
  }
}`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  args: {
    locked: true,
    trigger: {
      title: "Locked tool",
      subtitle: "Cannot close"
    },
    children: "Locked details"
  }
}`,...n.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    defer: true,
    defaultOpen: false,
    trigger: {
      title: "Deferred tool",
      subtitle: "Content mounts on open"
    },
    children: "Deferred content"
  }
}`,...r.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    forceOpen: true,
    trigger: {
      title: "Forced open",
      subtitle: "Cannot close"
    },
    children: "Forced content"
  }
}`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    hideDetails: true,
    trigger: {
      title: "Summary only",
      subtitle: "Details hidden"
    },
    children: "Hidden content"
  }
}`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [message, setMessage] = createSignal("Subtitle not clicked");
    return <div style={{
      display: "grid",
      gap: "8px"
    }}>
        <div style={{
        "font-size": "12px",
        color: "var(--text-weak)"
      }}>{message()}</div>
        <mod.BasicTool icon="mcp" trigger={{
        title: "Clickable subtitle",
        subtitle: "Click me"
      }} onSubtitleClick={() => setMessage("Subtitle clicked")}>
          Subtitle action details
        </mod.BasicTool>
      </div>;
  }
}`,...a.parameters?.docs?.source}}};const A=["Basic","Pending","Locked","Deferred","ForceOpen","HideDetails","SubtitleAction"];export{e as Basic,r as Deferred,o as ForceOpen,s as HideDetails,n as Locked,t as Pending,a as SubtitleAction,A as __namedExportsOrder,_ as default};
