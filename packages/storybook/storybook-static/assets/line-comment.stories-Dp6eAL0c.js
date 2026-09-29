import{i as s,b as d,c as m,t as a}from"./iframe-D288tw9h.js";import{L as l,a as c,b as v}from"./line-comment-DfcIBXeq.js";import"./preload-helper-D9Z9MdNV.js";import"./path-E3n8mp_5.js";import"./button-Bsz0PTzb.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./file-icon-CrT71WKR.js";import"./i18n-CW9P7x91.js";import"./use-filtered-list-XOqX6bHa.js";import"./map-B72Trknd.js";var u=a('<div style="position:relative;height:160px;padding:16px 16px 16px 40px;border:1px solid var(--border-weak);border-radius:8px;font-family:var(--font-family-mono);font-size:12px;color:var(--text-weak)"><div>12 | const total = sum(values)</div><div>13 | return total / values.length'),x=a('<div style="position:relative;height:220px;padding:16px 16px 16px 40px;border:1px solid var(--border-weak);border-radius:8px;font-family:var(--font-family-mono);font-size:12px;color:var(--text-weak)"><div>40 | if (values.length === 0) return 0'),f=a("<div data-slot=line-comment-content>Anchor content"),h=a('<div style="position:relative;height:120px;padding:16px 16px 16px 40px;border:1px solid var(--border-weak);border-radius:8px;font-family:var(--font-family-mono);font-size:12px;color:var(--text-weak)"><div>20 | const ready = true');const g=`### Overview
Inline comment anchor and editor for code review or annotation flows.

Pair with \`Diff\` or \`Code\` to align comments to lines.

### API
- \`LineCommentAnchor\`: position with \`top\`, control \`open\`, render custom children.
- \`LineComment\`: convenience wrapper for displaying comment + selection label.
- \`LineCommentEditor\`: controlled textarea with submit/cancel handlers.

### Variants and states
- Default display and editor display variants.

### Behavior
- Anchor positions relative to a containing element.
- Editor submits on Enter (Shift+Enter for newline).

### Accessibility
- TODO: confirm ARIA labeling for comment button and editor textarea.

### Theming/tokens
- Uses \`data-component="line-comment"\` and related slots.

`,$={title:"UI/LineComment",id:"components-line-comment",component:l,tags:["autodocs"],parameters:{docs:{description:{component:g}}}},n={render:()=>(()=>{var e=u(),r=e.firstChild;return r.nextSibling,s(e,d(l,{open:!0,top:18,comment:"Consider guarding against empty arrays.",selection:"L12-L13"}),null),e})()},o={render:()=>{const[e,r]=m("Add context for this change.");return(()=>{var i=x();return i.firstChild,s(i,d(c,{top:24,get value(){return e()},selection:"L40",onInput:r,onCancel:()=>r(""),onSubmit:p=>r(p)}),null),i})()}},t={render:()=>(()=>{var e=h();return e.firstChild,s(e,d(v,{top:18,open:!1,get children(){return f()}}),null),e})()};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Default = () => (
  <div
    style={{
      position: "relative",
      height: "160px",
      padding: "16px 16px 16px 40px",
      border: "1px solid var(--border-weak)",
      "border-radius": "8px",
      "font-family": "var(--font-family-mono)",
      "font-size": "12px",
      color: "var(--text-weak)",
    }}
  >
    <div>12 | const total = sum(values)</div>
    <div>13 | return total / values.length</div>
    <mod.LineComment
      open
      top={18}
      comment="Consider guarding against empty arrays."
      selection="L12-L13"
    />
  </div>
);
`,...n.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Editor = () => {
  const [value, setValue] = createSignal("Add context for this change.");
  return (
    <div
      style={{
        position: "relative",
        height: "220px",
        padding: "16px 16px 16px 40px",
        border: "1px solid var(--border-weak)",
        "border-radius": "8px",
        "font-family": "var(--font-family-mono)",
        "font-size": "12px",
        color: "var(--text-weak)",
      }}
    >
      <div>40 | if (values.length === 0) return 0</div>
      <mod.LineCommentEditor
        top={24}
        value={value()}
        selection="L40"
        onInput={setValue}
        onCancel={() => setValue("")}
        onSubmit={(next) => setValue(next)}
      />
    </div>
  );
};
`,...o.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const AnchorOnly = () => (
  <div
    style={{
      position: "relative",
      height: "120px",
      padding: "16px 16px 16px 40px",
      border: "1px solid var(--border-weak)",
      "border-radius": "8px",
      "font-family": "var(--font-family-mono)",
      "font-size": "12px",
      color: "var(--text-weak)",
    }}
  >
    <div>20 | const ready = true</div>
    <mod.LineCommentAnchor top={18} open={false}>
      <div data-slot="line-comment-content">Anchor content</div>
    </mod.LineCommentAnchor>
  </div>
);
`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    position: "relative",
    height: "160px",
    padding: "16px 16px 16px 40px",
    border: "1px solid var(--border-weak)",
    "border-radius": "8px",
    "font-family": "var(--font-family-mono)",
    "font-size": "12px",
    color: "var(--text-weak)"
  }}>
      <div>12 | const total = sum(values)</div>
      <div>13 | return total / values.length</div>
      <mod.LineComment open top={18} comment="Consider guarding against empty arrays." selection="L12-L13" />
    </div>
}`,...n.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("Add context for this change.");
    return <div style={{
      position: "relative",
      height: "220px",
      padding: "16px 16px 16px 40px",
      border: "1px solid var(--border-weak)",
      "border-radius": "8px",
      "font-family": "var(--font-family-mono)",
      "font-size": "12px",
      color: "var(--text-weak)"
    }}>
        <div>40 | if (values.length === 0) return 0</div>
        <mod.LineCommentEditor top={24} value={value()} selection="L40" onInput={setValue} onCancel={() => setValue("")} onSubmit={next => setValue(next)} />
      </div>;
  }
}`,...o.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    position: "relative",
    height: "120px",
    padding: "16px 16px 16px 40px",
    border: "1px solid var(--border-weak)",
    "border-radius": "8px",
    "font-family": "var(--font-family-mono)",
    "font-size": "12px",
    color: "var(--text-weak)"
  }}>
      <div>20 | const ready = true</div>
      <mod.LineCommentAnchor top={18} open={false}>
        <div data-slot="line-comment-content">Anchor content</div>
      </mod.LineCommentAnchor>
    </div>
}`,...t.parameters?.docs?.source}}};const I=["Default","Editor","AnchorOnly"];export{t as AnchorOnly,n as Default,o as Editor,I as __namedExportsOrder,$ as default};
