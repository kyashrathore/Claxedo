import{s as c,I as p,m as d,t as l}from"./iframe-D288tw9h.js";import{c as u}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var m=l("<input data-component=inline-input>");function h(a){const[e,n]=c(a,["class","width","style"]),i=()=>e.style?typeof e.style=="string"?e.width?`${e.style};width:${e.width}`:e.style:e.width?{...e.style,width:e.width}:e.style:{width:e.width};return(()=>{var r=m();return p(r,d({get class(){return e.class},get style(){return i()}},n),!1,!1),r})()}const y=Object.freeze(Object.defineProperty({__proto__:null,InlineInput:h},Symbol.toStringTag,{value:"Module"})),w=`### Overview
Compact inline input for short values.

Use inside text or table rows for quick edits.

### API
- Optional: \`width\` to set a fixed width.
- Accepts standard input props.

### Variants and states
- No built-in variants; style via class or width.

### Behavior
- Uses inline width when provided.

### Accessibility
- Provide a label or aria-label when used standalone.

### Theming/tokens
- Uses \`data-component="inline-input"\`.

`,o=u({title:"UI/InlineInput",mod:y,args:{placeholder:"Type...",value:"Inline"}}),g={title:"UI/InlineInput",id:"components-inline-input",component:o.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:w}}}},t=o.Basic,s={args:{value:"80px",width:"80px"}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  41 | }
  42 |
> 43 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  44 |
  45 | export const FixedWidth = {
  46 |   args: {`,...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const FixedWidth = () => <story.meta.component value="80px" width="80px" />;
`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:"story.Basic",...t.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    value: "80px",
    width: "80px"
  }
}`,...s.parameters?.docs?.source}}};const I=["Basic","FixedWidth"];export{t as Basic,s as FixedWidth,I as __namedExportsOrder,g as default};
