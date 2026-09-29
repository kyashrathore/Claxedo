import{s as y,r as O,b as e,m as S,i,S as h,K as k,x as v,V as E,aa as B,t as a,ab as R,c as P}from"./iframe-D288tw9h.js";import{c as V}from"./UGE6PPGT-C6B63Gso.js";import{D}from"./diff-changes-v2-CLFAeji0.js";import{T as F}from"./text-shimmer-v2-Dht9IOkC.js";import"./preload-helper-D9Z9MdNV.js";var z=a('<svg data-slot=basic-tool-v2-chevron class=ui-basic-tool-v2-chevron width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M6.75194 10.6243C6.41861 10.8187 6 10.5783 6 10.1924V5.80837C6 5.42247 6.41861 5.18204 6.75194 5.37648L10.5096 7.56846C10.8404 7.7614 10.8404 8.2393 10.5096 8.43224L6.75194 10.6243Z"fill=currentColor>'),L=a("<span data-slot=basic-tool-v2-chevron-wrap>"),N=a("<div data-slot=basic-tool-v2-labels>"),W=a("<div data-slot=basic-tool-v2-content-inner>"),G=a("<span data-slot=basic-tool-v2-title>"),I=a("<span data-slot=basic-tool-v2-sep aria-hidden=true>·"),j=a("<span data-slot=basic-tool-v2-subtitle>"),K=a("<span data-slot=basic-tool-v2-diff>"),M=a("<span data-slot=basic-tool-v2-arg>");function U(){return z()}const w=l=>typeof l=="object"&&l!==null&&"title"in l&&(typeof Node>"u"||!(l instanceof Node));function f(l){const[n,x]=y(l,["trigger","children","status","open","defaultOpen","onOpenChange","onSubtitleClick","class","classList"]),s=O(()=>n.status==="pending"||n.status==="running"),C=O(()=>n.children!=null),T=O(()=>C()&&!s()),$=r=>{s()||n.onOpenChange?.(r)},_=()=>{const r=n.trigger;return w(r)?void 0:r};return e(V,S(x,{"data-component":"basic-tool-v2",get open(){return n.open},get defaultOpen(){return n.defaultOpen},onOpenChange:$,get disabled(){return!T()},get classList(){return{...n.classList,[n.class??""]:!!n.class}},get children(){return[e(V.Trigger,{as:"div",role:"button","data-slot":"basic-tool-v2-trigger",class:"ui-basic-tool-v2-trigger",get children(){var r=N();return i(r,e(h,{get when(){return v(()=>!!w(n.trigger))()&&n.trigger},get fallback(){return _()},children:o=>[(()=>{var t=G();return i(t,e(F,{get text(){return o().title},get active(){return s()}})),t})(),e(h,{get when(){return v(()=>!s())()&&o().subtitle},get children(){return[I(),(()=>{var t=j();return t.$$click=b=>{n.onSubtitleClick&&(b.stopPropagation(),n.onSubtitleClick())},i(t,()=>o().subtitle),k(b=>R(t,n.onSubtitleClick?{cursor:"pointer"}:void 0,b)),t})()]}}),e(h,{get when(){return v(()=>!s())()&&o().args?.length},get children(){return e(E,{get each(){return o().args},children:t=>(()=>{var b=M();return i(b,t),b})()})}}),e(h,{get when(){return v(()=>!s())()&&o().changes},get children(){var t=K();return i(t,e(D,{get changes(){return o().changes}})),t}}),e(h,{get when(){return v(()=>!s())()&&o().action},children:t=>t()})]}),null),i(r,e(h,{get when(){return T()},get children(){var o=L();return i(o,e(U,{})),o}}),null),r}}),e(h,{get when(){return T()},get children(){return e(V.Content,{"data-slot":"basic-tool-v2-content",get children(){var r=W();return i(r,()=>n.children),r}})}})]}}))}B(["click"]);var A=a("<span style=color:#161616;font-size:13px;font-weight:440>Custom trigger content"),J=a('<div style=display:flex;flex-direction:column;gap:16px;max-width:420px><button type=button style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid rgba(0,0,0,0.15);background:#fff;color:#161616;cursor:pointer">Toggle from outside: ');const X='### Overview\nCompact collapsible tool row showing title, subtitle, args, and diff changes, with an expand/collapse chevron.\n\n### API\n- `BasicToolV2` wraps Kobalte `Collapsible`. Pass `open`, `defaultOpen`, and `onOpenChange` for controlled/uncontrolled disclosure.\n- `trigger` accepts either a `BasicToolV2TriggerTitle` object (title, subtitle, args, changes) or arbitrary JSX.\n- When `status` is `"pending"` or `"running"`, subtitle/args/chevron hide and the title shows a shimmer animation.\n- Pass `children` for expandable detail content.\n\n### Theming\n- Uses `data-component="basic-tool-v2"` and slot attributes; colors via `--bt-*` CSS variables.\n',ee={title:"UI V2/BasicTool",id:"components-basic-tool-v2",component:f,tags:["autodocs"],parameters:{frameBackground:"#fff",layout:"padded",docs:{description:{component:X}}}},c={render:()=>e(f,{trigger:{title:"Read",subtitle:"src/index.ts",args:["lines=1-50"],changes:{additions:12,deletions:3}},defaultOpen:!1,children:"File content appears here."})},d={render:()=>e(f,{trigger:{title:"Read",subtitle:"src/index.ts",args:["lines=1-50"],changes:{additions:12,deletions:3}},defaultOpen:!0,children:"File content appears here."})},p={render:()=>e(f,{trigger:{title:"Read",subtitle:"src/index.ts",args:["lines=1-50"],changes:{additions:12,deletions:3}},status:"pending"})},g={render:()=>e(f,{trigger:{title:"Grep",subtitle:"pattern=TODO",args:["recursive=true"]}})},u={render:()=>e(f,{get trigger(){return A()},children:"Expandable detail for custom trigger."})},m={render:()=>{const[l,n]=P(!1);return(()=>{var x=J(),s=x.firstChild;return s.firstChild,s.$$click=()=>n(C=>!C),i(s,()=>l()?"Open":"Closed",null),i(x,e(f,{trigger:{title:"Write",subtitle:"src/utils.ts",changes:{additions:8,deletions:2}},get open(){return l()},onOpenChange:n,children:"Controlled content."}),null),x})()}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Default = () => (
  <BasicToolV2
    trigger={{
      title: "Read",
      subtitle: "src/index.ts",
      args: ["lines=1-50"],
      changes: { additions: 12, deletions: 3 },
    }}
    defaultOpen={false}
  >
    File content appears here.
  </BasicToolV2>
);
`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Expanded = () => (
  <BasicToolV2
    trigger={{
      title: "Read",
      subtitle: "src/index.ts",
      args: ["lines=1-50"],
      changes: { additions: 12, deletions: 3 },
    }}
    defaultOpen={true}
  >
    File content appears here.
  </BasicToolV2>
);
`,...d.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Pending = () => (
  <BasicToolV2
    trigger={{
      title: "Read",
      subtitle: "src/index.ts",
      args: ["lines=1-50"],
      changes: { additions: 12, deletions: 3 },
    }}
    status="pending"
  />
);
`,...p.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{code:`const NoChildren = () => (
  <BasicToolV2
    trigger={{
      title: "Grep",
      subtitle: "pattern=TODO",
      args: ["recursive=true"],
    }}
  />
);
`,...g.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const CustomTrigger = () => (
  <BasicToolV2
    trigger={
      <span
        style={{ color: "#161616", "font-size": "13px", "font-weight": "440" }}
      >
        Custom trigger content
      </span>
    }
  >
    Expandable detail for custom trigger.
  </BasicToolV2>
);
`,...u.parameters?.docs?.source}}};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{code:`const Controlled = () => {
  const [open, setOpen] = createSignal(false);
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "16px",
        "max-width": "420px",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "4px 10px",
          "font-size": "12px",
          "border-radius": "6px",
          border: "1px solid rgba(0,0,0,0.15)",
          background: "#fff",
          color: "#161616",
          cursor: "pointer",
        }}
      >
        Toggle from outside: {open() ? "Open" : "Closed"}
      </button>
      <BasicToolV2
        trigger={{
          title: "Write",
          subtitle: "src/utils.ts",
          changes: { additions: 8, deletions: 2 },
        }}
        open={open()}
        onOpenChange={setOpen}
      >
        Controlled content.
      </BasicToolV2>
    </div>
  );
};
`,...m.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => <BasicToolV2 trigger={{
    title: "Read",
    subtitle: "src/index.ts",
    args: ["lines=1-50"],
    changes: {
      additions: 12,
      deletions: 3
    }
  }} defaultOpen={false}>
      File content appears here.
    </BasicToolV2>
}`,...c.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <BasicToolV2 trigger={{
    title: "Read",
    subtitle: "src/index.ts",
    args: ["lines=1-50"],
    changes: {
      additions: 12,
      deletions: 3
    }
  }} defaultOpen={true}>
      File content appears here.
    </BasicToolV2>
}`,...d.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => <BasicToolV2 trigger={{
    title: "Read",
    subtitle: "src/index.ts",
    args: ["lines=1-50"],
    changes: {
      additions: 12,
      deletions: 3
    }
  }} status="pending" />
}`,...p.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{originalSource:`{
  render: () => <BasicToolV2 trigger={{
    title: "Grep",
    subtitle: "pattern=TODO",
    args: ["recursive=true"]
  }} />
}`,...g.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => <BasicToolV2 trigger={<span style={{
    color: "#161616",
    "font-size": "13px",
    "font-weight": "440"
  }}>Custom trigger content</span>}>
      Expandable detail for custom trigger.
    </BasicToolV2>
}`,...u.parameters?.docs?.source}}};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [open, setOpen] = createSignal(false);
    return <div style={{
      display: "flex",
      "flex-direction": "column",
      gap: "16px",
      "max-width": "420px"
    }}>
        <button type="button" onClick={() => setOpen(o => !o)} style={{
        padding: "4px 10px",
        "font-size": "12px",
        "border-radius": "6px",
        border: "1px solid rgba(0,0,0,0.15)",
        background: "#fff",
        color: "#161616",
        cursor: "pointer"
      }}>
          Toggle from outside: {open() ? "Open" : "Closed"}
        </button>
        <BasicToolV2 trigger={{
        title: "Write",
        subtitle: "src/utils.ts",
        changes: {
          additions: 8,
          deletions: 2
        }
      }} open={open()} onOpenChange={setOpen}>
          Controlled content.
        </BasicToolV2>
      </div>;
  }
}`,...m.parameters?.docs?.source}}};B(["click"]);const ne=["Default","Expanded","Pending","NoChildren","CustomTrigger","Controlled"];export{m as Controlled,u as CustomTrigger,c as Default,d as Expanded,g as NoChildren,p as Pending,ne as __namedExportsOrder,ee as default};
