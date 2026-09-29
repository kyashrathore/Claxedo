import{s as w,r as v,b as r,m as O,i as n,S as m,K as T,aa as V,t as s,L as $,c as E,x as _}from"./iframe-D288tw9h.js";import{B as k}from"./button-v2-DbG8OeJh.js";import{c as b}from"./UGE6PPGT-C6B63Gso.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var S=s('<svg data-slot=tool-error-card-ban width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M3.44283 12.5575L12.5495 3.45081M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z"stroke=currentColor>'),L=s('<svg data-slot=tool-error-card-loader width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><g transform="translate(8 8)"><circle r=5.9 fill=none stroke=var(--v2-icon-icon-base) stroke-width=1 stroke-opacity=0.3 transform=rotate(-90)></circle><circle r=5.9 fill=none stroke=var(--v2-icon-icon-base) stroke-width=1 pathLength=100 stroke-dasharray="25 75"transform=rotate(-90)>'),y=s('<svg data-slot=tool-error-card-chevron class=ui-tool-error-card-chevron width=14 height=14 viewBox="0 0 14 14"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M5.90795 9.62425C5.61628 9.81865 5.25 9.57825 5.25 9.19235V4.80837C5.25 4.42247 5.61628 4.18204 5.90795 4.37648L9.1959 6.56846C9.48535 6.7614 9.48535 7.2393 9.1959 7.43224L5.90795 9.62425Z"fill=currentColor>'),P=s("<span data-slot=tool-error-card-icon-wrap>"),B=s("<a data-slot=tool-error-card-subtitle>"),D=s("<span data-slot=tool-error-card-chevron-wrap>"),H=s("<div data-slot=tool-error-card-main><div data-slot=tool-error-card-labels><span data-slot=tool-error-card-title></span><span data-slot=tool-error-card-sep aria-hidden=true>·"),I=s("<div data-slot=tool-error-card-suffix>"),N=s("<span data-slot=tool-error-card-subtitle>");function R(){return S()}function M(){return(()=>{var t=L(),e=t.firstChild,u=e.firstChild;return u.nextSibling,t})()}function G(){return y()}function f(t){const[e,u]=w(t,["title","subtitle","suffix","loading","open","defaultOpen","onOpenChange","subtitleHref","class","classList"]),g=v(()=>{const o=e.suffix;return o==null?!1:typeof o=="string"?o.length>0:!0});return r(b,O(u,{"data-component":"tool-error-card",get open(){return e.open},get defaultOpen(){return e.defaultOpen},get onOpenChange(){return e.onOpenChange},get disabled(){return!g()},get"aria-busy"(){return e.loading?!0:void 0},get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return[r(b.Trigger,{as:"div",role:"button","data-slot":"tool-error-card-trigger",class:"ui-tool-error-card-trigger",get children(){return[(()=>{var o=P();return n(o,r(m,{get when(){return e.loading},get fallback(){return r(R,{})},get children(){return r(M,{})}})),o})(),(()=>{var o=H(),h=o.firstChild,x=h.firstChild;return x.nextSibling,n(x,()=>e.title),n(h,r(m,{get when(){return e.subtitleHref},get fallback(){return(()=>{var a=N();return n(a,()=>e.subtitle),a})()},get children(){var a=B();return a.$$pointerdown=C=>C.stopPropagation(),a.$$click=C=>C.stopPropagation(),n(a,()=>e.subtitle),T(()=>$(a,"href",e.subtitleHref)),a}}),null),n(h,r(m,{get when(){return g()},get children(){var a=D();return n(a,r(G,{})),a}}),null),o})()]}}),r(m,{get when(){return g()},get children(){return r(b.Content,{"data-slot":"tool-error-card-content",get children(){var o=I();return n(o,()=>e.suffix),o}})}})]}}))}V(["click","pointerdown"]);var W=s("<div style=display:flex;flex-direction:column;gap:24px;max-width:420px>");const q='### Overview\nCompact tool error row with optional expandable detail, aligned to the OpenCode design system spec.\n\n### API\n- `ToolErrorCardV2` wraps Kobalte `Collapsible` directly. Pass `open`, `defaultOpen`, and `onOpenChange` like any disclosure (controlled when `open` is defined).\n- Without a non-empty `suffix`, the card is not expandable (`disabled` on the collapsible root).\n\n### Theming\n- Uses `data-component="tool-error-card"` and slot attributes; colors are CSS variables on the root (`--tec-*`).\n',J={title:"UI V2/ToolErrorCard",id:"components-tool-error-card-v2",component:f,tags:["autodocs"],parameters:{frameBackground:"#fff",layout:"padded",docs:{description:{component:q}}}},l={args:{title:"Read",subtitle:"Permission denied",suffix:"The tool could not access the requested path.",defaultOpen:!1},render:t=>r(f,t)},i={args:{title:"Read",subtitle:"Working",suffix:"Details appear when the tool finishes.",loading:!0,defaultOpen:!1},render:t=>r(f,t)},d={args:{title:"Task",subtitle:"View logs",subtitleHref:"https://example.com",suffix:"Subagent exited with code 1.",defaultOpen:!1},render:t=>r(f,t)},c={args:{title:"List",subtitle:"No detail",defaultOpen:!1},render:t=>r(f,t)},p={render:()=>{const[t,e]=E(!1);return(()=>{var u=W();return n(u,r(k,{type:"button",classList:{"w-fit":!0},onClick:()=>e(g=>!g),get children(){return["Toggle from outside: ",_(()=>t()?"Open":"Closed")]}}),null),n(u,r(f,{title:"Grep",subtitle:"Timeout",suffix:"Operation exceeded 30s.",get open(){return t()},onOpenChange:e}),null),u})()}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const Default = () => <ToolErrorCardV2 />;
`,...l.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Loading = () => <ToolErrorCardV2 />;
`,...i.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const SubtitleLink = () => <ToolErrorCardV2 />;
`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const NoSuffixDisabled = () => <ToolErrorCardV2 />;
`,...c.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Controlled = () => {
  const [open, setOpen] = createSignal(false);
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "24px",
        "max-width": "420px",
      }}
    >
      <ButtonV2
        type="button"
        classList={{ "w-fit": true }}
        onClick={() => setOpen((o) => !o)}
      >
        Toggle from outside: {open() ? "Open" : "Closed"}
      </ButtonV2>
      <ToolErrorCardV2
        title="Grep"
        subtitle="Timeout"
        suffix="Operation exceeded 30s."
        open={open()}
        onOpenChange={setOpen}
      />
    </div>
  );
};
`,...p.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  args: {
    title: "Read",
    subtitle: "Permission denied",
    suffix: "The tool could not access the requested path.",
    defaultOpen: false
  } satisfies ToolErrorCardV2Props,
  render: (args: ToolErrorCardV2Props) => <ToolErrorCardV2 {...args} />
}`,...l.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  args: {
    title: "Read",
    subtitle: "Working",
    suffix: "Details appear when the tool finishes.",
    loading: true,
    defaultOpen: false
  } satisfies ToolErrorCardV2Props,
  render: (args: ToolErrorCardV2Props) => <ToolErrorCardV2 {...args} />
}`,...i.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  args: {
    title: "Task",
    subtitle: "View logs",
    subtitleHref: "https://example.com",
    suffix: "Subagent exited with code 1.",
    defaultOpen: false
  } satisfies ToolErrorCardV2Props,
  render: (args: ToolErrorCardV2Props) => <ToolErrorCardV2 {...args} />
}`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  args: {
    title: "List",
    subtitle: "No detail",
    defaultOpen: false
  } satisfies ToolErrorCardV2Props,
  render: (args: ToolErrorCardV2Props) => <ToolErrorCardV2 {...args} />
}`,...c.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [open, setOpen] = createSignal(false);
    return <div style={{
      display: "flex",
      "flex-direction": "column",
      gap: "24px",
      "max-width": "420px"
    }}>
        <ButtonV2 type="button" classList={{
        "w-fit": true
      }} onClick={() => setOpen(o => !o)}>
          Toggle from outside: {open() ? "Open" : "Closed"}
        </ButtonV2>
        <ToolErrorCardV2 title="Grep" subtitle="Timeout" suffix="Operation exceeded 30s." open={open()} onOpenChange={setOpen} />
      </div>;
  }
}`,...p.parameters?.docs?.source}}};const Q=["Default","Loading","SubtitleLink","NoSuffixDisabled","Controlled"];export{p as Controlled,l as Default,i as Loading,c as NoSuffixDisabled,d as SubtitleLink,Q as __namedExportsOrder,J as default};
