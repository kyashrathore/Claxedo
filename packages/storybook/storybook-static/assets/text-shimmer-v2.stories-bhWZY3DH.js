import{i,b as a,t as o}from"./iframe-D288tw9h.js";import{T as r}from"./text-shimmer-v2-Dht9IOkC.js";import"./preload-helper-D9Z9MdNV.js";var m=o('<span style="font-size:13px;font-weight:440;font-family:Inter, system-ui, sans-serif">'),c=o('<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;font-weight:440;font-family:Inter, system-ui, sans-serif">');const f='### Overview\nAnimated shimmer effect for loading text placeholders.\n\n### API\n- Required: `text` string.\n- Optional: `as`, `active`, `offset`, `class`.\n\n### Behavior\n- Uses a moving gradient sweep clipped to text.\n- `offset` lets multiple shimmers run out-of-phase.\n\n### Accessibility\n- Uses `aria-label` with the full text.\n\n### Theming\n- Uses `data-component="text-shimmer-v2"` and CSS custom properties for timing and colors.\n',x={title:"UI V2/TextShimmer",id:"components-text-shimmer-v2",component:r,tags:["autodocs"],parameters:{frameBackground:"#fff",layout:"padded",docs:{description:{component:f}}}},t={render:()=>(()=>{var e=m();return i(e,a(r,{text:"Loading...",active:!0})),e})()},s={render:()=>(()=>{var e=m();return i(e,a(r,{text:"Static text",active:!1})),e})()},n={render:()=>(()=>{var e=c();return i(e,a(r,{text:"First line",active:!0,offset:0}),null),i(e,a(r,{text:"Second line",active:!0,offset:5}),null),i(e,a(r,{text:"Third line",active:!0,offset:10}),null),e})()};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Active = () => (
  <span
    style={{
      "font-size": "13px",
      "font-weight": "440",
      "font-family": "Inter, system-ui, sans-serif",
    }}
  >
    <TextShimmerV2 text="Loading..." active={true} />
  </span>
);
`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Inactive = () => (
  <span
    style={{
      "font-size": "13px",
      "font-weight": "440",
      "font-family": "Inter, system-ui, sans-serif",
    }}
  >
    <TextShimmerV2 text="Static text" active={false} />
  </span>
);
`,...s.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const WithOffset = () => (
  <div
    style={{
      display: "flex",
      "flex-direction": "column",
      gap: "8px",
      "font-size": "13px",
      "font-weight": "440",
      "font-family": "Inter, system-ui, sans-serif",
    }}
  >
    <TextShimmerV2 text="First line" active={true} offset={0} />
    <TextShimmerV2 text="Second line" active={true} offset={5} />
    <TextShimmerV2 text="Third line" active={true} offset={10} />
  </div>
);
`,...n.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <span style={{
    "font-size": "13px",
    "font-weight": "440",
    "font-family": "Inter, system-ui, sans-serif"
  }}>
      <TextShimmerV2 text="Loading..." active={true} />
    </span>
}`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <span style={{
    "font-size": "13px",
    "font-weight": "440",
    "font-family": "Inter, system-ui, sans-serif"
  }}>
      <TextShimmerV2 text="Static text" active={false} />
    </span>
}`,...s.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    "flex-direction": "column",
    gap: "8px",
    "font-size": "13px",
    "font-weight": "440",
    "font-family": "Inter, system-ui, sans-serif"
  }}>
      <TextShimmerV2 text="First line" active={true} offset={0} />
      <TextShimmerV2 text="Second line" active={true} offset={5} />
      <TextShimmerV2 text="Third line" active={true} offset={10} />
    </div>
}`,...n.parameters?.docs?.source}}};const u=["Active","Inactive","WithOffset"];export{t as Active,s as Inactive,n as WithOffset,u as __namedExportsOrder,x as default};
