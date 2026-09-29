import{Z as u,a as y,b as l,n as g,x as f,S as h,K as x,D as w,t as T}from"./iframe-D288tw9h.js";import{c as b}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var I=T("<span>│");const S=a=>{const[i,r]=u({typing:!1,displayed:"",cursor:!0});return y(()=>{const s=a.text;if(!s)return;let c=0;const n=[];r("typing",!0),r("displayed",""),r("cursor",!0);const d=()=>{const o=Math.random();return o<.05?150+Math.random()*100:o<.15?80+Math.random()*60:30+Math.random()*50},p=()=>{c<s.length?(r("displayed",s.slice(0,c+1)),c++,n.push(setTimeout(p,d()))):(r("typing",!1),n.push(setTimeout(()=>r("cursor",!1),2e3)))};n.push(setTimeout(p,200)),g(()=>{for(const o of n)clearTimeout(o)})}),l(w,{get component(){return a.as||"p"},get class(){return a.class},get children(){return[f(()=>i.displayed),l(h,{get when(){return i.cursor},get children(){var s=I();return x(()=>s.classList.toggle("blinking-cursor",!i.typing)),s}})]}})},_=Object.freeze(Object.defineProperty({__proto__:null,Typewriter:S},Symbol.toStringTag,{value:"Module"})),O=`### Overview
Animated typewriter text effect for short inline messages.

Use for short status lines; avoid long paragraphs.

### API
- Optional: \`text\` string; if absent, nothing is rendered.
- Optional: \`as\` to change the rendered element.

### Variants and states
- Single animation style with cursor blink.

### Behavior
- Types one character at a time with randomized delays.

### Accessibility
- TODO: confirm if cursor should be aria-hidden in all contexts.

### Theming/tokens
- Uses \`blinking-cursor\` class for cursor styling.

`,m=b({title:"UI/Typewriter",mod:_,args:{text:"Typewriter text"}}),k={title:"UI/Typewriter",id:"components-typewriter",component:m.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:O}}}},e=m.Basic,t={args:{text:"Inline typewriter",as:"span"}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  42 | }
  43 |
> 44 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  45 |
  46 | export const Inline = {
  47 |   args: {`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Inline = () => (
  <story.meta.component text="Inline typewriter" as="span" />
);
`,...t.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    text: "Inline typewriter",
    as: "span"
  }
}`,...t.parameters?.docs?.source}}};const D=["Basic","Inline"];export{e as Basic,t as Inline,D as __namedExportsOrder,k as default};
