import{i as c,b as d,t as p,aa as l}from"./iframe-D288tw9h.js";import{m,T as u}from"./text-shimmer-SJimTaBu.js";import{c as x}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var g=p('<div style=display:grid;gap:12px;justify-items:start><button style="padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--color-divider, #333);background:var(--color-fill-element, #222);color:var(--color-text, #eee);cursor:pointer">Reset controls');const{useArgs:v}=__STORYBOOK_MODULE_PREVIEW_API__,f=`### Overview
Animated shimmer effect for loading text placeholders.

Use for pending states inside buttons or list rows.

### API
- Required: \`text\` string.
- Optional: \`as\`, \`active\`, \`offset\`, \`class\`.

### Variants and states
- Active/inactive state via \`active\`.

### Behavior
- Uses a moving gradient sweep clipped to text.
- \`offset\` lets multiple shimmers run out-of-phase.

### Accessibility
- Uses \`aria-label\` with the full text.

### Theming/tokens
- Uses \`data-component="text-shimmer"\` and CSS custom properties for timing.

`,r={text:"Loading...",active:!0,class:"text-14-medium text-text-strong",offset:0},b=x({title:"UI/TextShimmer",mod:m,args:r}),_={title:"UI/TextShimmer",id:"components-text-shimmer",component:b.meta.component,tags:["autodocs"],args:r,argTypes:{text:{control:"text"},class:{control:"text"},active:{control:"boolean"},offset:{control:{type:"range",min:0,max:80,step:1}}},parameters:{docs:{description:{component:f}}}},e={args:r,render:n=>{const[,a]=v(),i=()=>a(r);return(()=>{var s=g(),o=s.firstChild;return c(s,d(u,n),o),o.$$click=i,s})()}},t={args:{text:"Static text",active:!1}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => {
  const [, updateArgs] = useArgs();
  const reset = () => updateArgs(defaults);

  return (
    <div style={{ display: "grid", gap: "12px", "justify-items": "start" }}>
      <mod.TextShimmer />
      <button
        onClick={reset}
        style={{
          padding: "4px 10px",
          "font-size": "12px",
          "border-radius": "6px",
          border: "1px solid var(--color-divider, #333)",
          background: "var(--color-fill-element, #222)",
          color: "var(--color-text, #eee)",
          cursor: "pointer",
        }}
      >
        Reset controls
      </button>
    </div>
  );
};
`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Inactive = () => (
  <story.meta.component text="Static text" active={false} />
);
`,...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  args: defaults,
  render: args => {
    const [, updateArgs] = useArgs();
    const reset = () => updateArgs(defaults);
    return <div style={{
      display: "grid",
      gap: "12px",
      "justify-items": "start"
    }}>
        <mod.TextShimmer {...args} />
        <button onClick={reset} style={{
        padding: "4px 10px",
        "font-size": "12px",
        "border-radius": "6px",
        border: "1px solid var(--color-divider, #333)",
        background: "var(--color-fill-element, #222)",
        color: "var(--color-text, #eee)",
        cursor: "pointer"
      }}>
          Reset controls
        </button>
      </div>;
  }
}`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    text: "Static text",
    active: false
  }
}`,...t.parameters?.docs?.source}}};l(["click"]);const T=["Basic","Inactive"];export{e as Basic,t as Inactive,T as __namedExportsOrder,_ as default};
