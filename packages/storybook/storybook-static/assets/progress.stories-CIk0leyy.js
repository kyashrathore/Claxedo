import{d as C,e as x,s as m,c as M,r as S,b as a,m as o,P as b,a as T,h as O,l as B,j as R,n as $,x as Q,p as j,q as U,a_ as E,_ as X,S as k,i as _,t as Y}from"./iframe-D288tw9h.js";import{a as N}from"./LP6E37CW-BgXoIsgV.js";import{c as Z}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";var A=B();function V(){const t=R(A);if(t===void 0)throw new Error("[kobalte]: `useMeterContext` must be used within a `Meter.Root` component");return t}function ee(t){const r=V(),[s,e]=m(t,["style"]);return a(b,o({as:"div",get style(){return O({"--kb-meter-fill-width":r.meterFillWidth()},s.style)}},()=>r.dataset(),e))}function re(t){const r=V(),s=x({id:r.generateId("label")},t),[e,n]=m(s,["id"]);return T(()=>$(r.registerLabelId(e.id))),a(b,o({as:"span",get id(){return e.id}},()=>r.dataset(),n))}function te(t){const r=`meter-${C()}`,s=x({id:r,value:0,minValue:0,maxValue:100,role:"meter",indeterminate:!1},t),[e,n]=m(s,["value","minValue","maxValue","getValueLabel","role","aria-valuetext","aria-labelledby","aria-valuemax","aria-valuemin","aria-valuenow","indeterminate"]),[L,P]=M(),w=N(()=>({style:"percent"})),l=()=>E(e.value,e.minValue,e.maxValue),i=()=>(l()-e.minValue)/(e.maxValue-e.minValue),f=()=>{if(!e.indeterminate)return e.getValueLabel?e.getValueLabel({value:l(),min:e.minValue,max:e.maxValue}):w().format(i())},y=()=>`${i()*100}%`,p=S(()=>({})),I={dataset:p,value:l,valuePercent:i,valueLabel:f,labelId:L,meterFillWidth:y,generateId:U(()=>n.id),registerLabelId:j(P)};return a(A.Provider,{value:I,get children(){return a(b,o({as:"div",get role(){return e.role||"meter"},get"aria-valuenow"(){return Q(()=>!!e.indeterminate)()?void 0:l()},get"aria-valuemin"(){return e.minValue},get"aria-valuemax"(){return e.maxValue},get"aria-valuetext"(){return f()},get"aria-labelledby"(){return L()}},p,n))}})}function ae(t){const r=V();return a(b,o({as:"div"},()=>r.dataset(),t))}function se(t){const r=V();return a(b,o({as:"div"},()=>r.dataset(),t,{get children(){return r.valueLabel()}}))}var v=Object.assign(te,{Fill:ee,Label:re,Track:ae,ValueLabel:se}),oe={};X(oe,{Fill:()=>K,Label:()=>q,Progress:()=>g,Root:()=>D,Track:()=>z,ValueLabel:()=>G,useProgressContext:()=>h});var W=B();function h(){const t=R(W);if(t===void 0)throw new Error("[kobalte]: `useProgressContext` must be used within a `Progress.Root` component");return t}function K(t){const r=h(),[s,e]=m(t,["style"]);return a(v.Fill,o({get style(){return O({"--kb-progress-fill-width":r.progressFillWidth()},s.style)}},()=>r.dataset(),e))}function q(t){const r=h(),s=x({id:r.generateId("label")},t),[e,n]=m(s,["id"]);return T(()=>$(r.registerLabelId(e.id))),a(v.Label,o({get id(){return e.id}},()=>r.dataset(),n))}function D(t){const r=`progress-${C()}`,s=x({id:r,value:0,minValue:0,maxValue:100},t),[e,n]=m(s,["value","minValue","maxValue","indeterminate","getValueLabel"]),[L,P]=M(),w=N(()=>({style:"percent"})),l=()=>E(e.value,e.minValue,e.maxValue),i=()=>(l()-e.minValue)/(e.maxValue-e.minValue),f=()=>{if(!e.indeterminate)return e.getValueLabel?e.getValueLabel({value:l(),min:e.minValue,max:e.maxValue}):w().format(i())},y=()=>e.indeterminate?void 0:`${i()*100}%`,p=S(()=>{let F;return e.indeterminate||(F=i()===1?"complete":"loading"),{"data-progress":F,"data-indeterminate":e.indeterminate?"":void 0}}),I={dataset:p,value:l,valuePercent:i,valueLabel:f,labelId:L,progressFillWidth:y,generateId:U(()=>n.id),registerLabelId:j(P)};return a(W.Provider,{value:I,get children(){return a(v,o({role:"progressbar",get indeterminate(){return e.indeterminate||!1}},p,s))}})}function z(t){const r=h();return a(v.Track,o(()=>r.dataset(),t))}function G(t){const r=h();return a(v.ValueLabel,o(()=>r.dataset(),t))}var g=Object.assign(D,{Fill:K,Label:q,Track:z,ValueLabel:G}),ne=Y("<div data-slot=progress-header>");function H(t){const[r,s]=m(t,["children","class","classList","hideLabel","showValueLabel"]);return a(g,o(s,{"data-component":"progress",get classList(){return{...r.classList,[r.class??""]:!!r.class}},get children(){return[a(k,{get when(){return r.children||r.showValueLabel},get children(){var e=ne();return _(e,a(k,{get when(){return r.children},get children(){return a(g.Label,{"data-slot":"progress-label",get classList(){return{"ui-progress-label":!0,"sr-only":r.hideLabel}},get children(){return r.children}})}}),null),_(e,a(k,{get when(){return r.showValueLabel},get children(){return a(g.ValueLabel,{"data-slot":"progress-value-label",class:"ui-progress-value-label"})}}),null),e}}),a(g.Track,{"data-slot":"progress-track",get children(){return a(g.Fill,{"data-slot":"progress-fill",class:"ui-progress-fill"})}})]}}))}const le=Object.freeze(Object.defineProperty({__proto__:null,Progress:H},Symbol.toStringTag,{value:"Module"})),ie=`### Overview
Linear progress indicator with optional label and value display.

Use in forms, uploads, or background tasks.

### API
- \`value\` and \`maxValue\` control progress.
- Optional: \`showValueLabel\`, \`hideLabel\`.
- Children provide the label text.

### Variants and states
- Supports indeterminate state via Kobalte props (if provided).

### Behavior
- Uses Kobalte Progress for value calculation.

### Accessibility
- TODO: confirm ARIA attributes from Kobalte.

### Theming/tokens
- Uses \`data-component="progress"\` with track/fill slots.

`,J=Z({title:"UI/Progress",mod:le,args:{value:60,maxValue:100,children:"Progress",showValueLabel:!0}}),ge={title:"UI/Progress",id:"components-progress",component:J.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:ie}}}},c=J.Basic,u={args:{children:"",hideLabel:!0,showValueLabel:!1,value:30}},d={render:()=>a(H,{children:"Loading"})};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  52 | }
  53 |
> 54 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  55 |
  56 | export const NoLabel = {
  57 |   args: {`,...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const NoLabel = () => (
  <story.meta.component
    hideLabel
    showValueLabel={false}
    value={30}
  ></story.meta.component>
);
`,...u.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Indeterminate = () => <mod.Progress>Loading</mod.Progress>;
`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:"story.Basic",...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  args: {
    children: "",
    hideLabel: true,
    showValueLabel: false,
    value: 30
  }
}`,...u.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <mod.Progress>Loading</mod.Progress>
}`,...d.parameters?.docs?.source}}};const pe=["Basic","NoLabel","Indeterminate"];export{c as Basic,d as Indeterminate,u as NoLabel,pe as __namedExportsOrder,ge as default};
