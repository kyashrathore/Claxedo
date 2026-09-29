import{s as u,I as f,m as h,i as c,t as l,aa as v,aN as g,ad as _,b as m,K as i,L as d}from"./iframe-D288tw9h.js";import{c as b}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var k=l("<div>");function P(r){const[e,t]=u(r,["children","class","classList"]);return(()=>{var o=k();return f(o,h(t,{"data-dock-surface":"shell",get classList(){return{...e.classList,[e.class??""]:!!e.class}}}),!1,!0),c(o,()=>e.children),o})()}function $(r){const[e,t]=u(r,["attach","children","class","classList"]);return(()=>{var o=k();return f(o,h(t,{"data-dock-surface":"tray",get"data-dock-attach"(){return e.attach||"none"},get classList(){return{...e.classList,[e.class??""]:!!e.class}}}),!1,!0),c(o,()=>e.children),o})()}var p=l("<div>"),w=l("<div data-component=dock-prompt class=ui-dock-prompt>");function A(r){const e=t=>`${r.kind}-${t}`;return(()=>{var t=w();g(t,"keydown",r.onKeyDown,!0);var o=r.ref;return typeof o=="function"?_(o,t):r.ref=t,c(t,m(P,{get"data-slot"(){return e("body")},get children(){return[(()=>{var n=p();return c(n,()=>r.header),i(()=>d(n,"data-slot",e("header"))),n})(),(()=>{var n=p();return c(n,()=>r.children),i(()=>d(n,"data-slot",e("content"))),n})()]}}),null),c(t,m($,{get"data-slot"(){return e("footer")},get children(){return r.footer}}),null),i(()=>d(t,"data-kind",r.kind)),t})()}v(["keydown"]);const L=Object.freeze(Object.defineProperty({__proto__:null,DockPrompt:A},Symbol.toStringTag,{value:"Module"})),x=`### Overview
Docked prompt layout for questions and permission requests.

Use with form controls or confirmation buttons in the footer.

### API
- Required: \`kind\` (question | permission), \`header\`, \`children\`, \`footer\`.
- Optional: \`ref\` for measuring or focus management.

### Variants and states
- Question and permission layouts (data attributes).

### Behavior
- Pure layout component; behavior handled by parent.

### Accessibility
- Ensure header and footer content provide clear context and actions.

### Theming/tokens
- Uses \`data-component="dock-prompt"\` with kind data attribute.

`,y=b({title:"UI/DockPrompt",mod:L,args:{kind:"question",header:"Header",children:"Prompt content",footer:"Footer"}}),T={title:"UI/DockPrompt",id:"components-dock-prompt",component:y.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:x}}}},s=y.Basic,a={args:{kind:"permission",header:"Allow access?",children:"This action needs permission to proceed.",footer:"Approve or deny"}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  51 | }
  52 |
> 53 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  54 |
  55 | export const Permission = {
  56 |   args: {`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Permission = () => (
  <story.meta.component
    kind="permission"
    header="Allow access?"
    footer="Approve or deny"
  >
    This action needs permission to proceed.
  </story.meta.component>
);
`,...a.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:"story.Basic",...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  args: {
    kind: "permission",
    header: "Allow access?",
    children: "This action needs permission to proceed.",
    footer: "Approve or deny"
  }
}`,...a.parameters?.docs?.source}}};const q=["Basic","Permission"];export{s as Basic,a as Permission,q as __namedExportsOrder,T as default};
