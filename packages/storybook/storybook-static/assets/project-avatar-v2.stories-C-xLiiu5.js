import{s as _,I as x,m as P,i as m,b as d,K as h,t as v,x as R,L as u,S as y,V as O}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var S=v("<span data-slot=project-avatar-unread-dot aria-hidden=true>"),T=v("<div><div data-slot=project-avatar-surface class=ui-project-avatar-surface>"),I=v("<img data-slot=project-avatar-image>");const k=typeof Intl<"u"&&"Segmenter"in Intl?new Intl.Segmenter(void 0,{granularity:"grapheme"}):void 0;function U(r){return r?k?k.segment(r)[Symbol.iterator]().next().value?.segment??Array.from(r)[0]??"":Array.from(r)[0]??"":""}const f=["orange","yellow","cyan","green","red","pink","blue","purple","gray"];function A(r){const[a,V]=_(r,["fallback","src","variant","unread","class","classList","style"]);return(()=>{var p=T(),g=p.firstChild;return x(p,P(V,{"data-component":"project-avatar-v2",get"data-unread"(){return a.unread?"":void 0},get classList(){return{"ui-project-avatar-v2":!0,...a.classList,[a.class??""]:!!a.class}},get style(){return R(()=>typeof a.style=="object")()?a.style:void 0}}),!1,!0),m(g,d(y,{get when(){return a.src},get fallback(){return U(a.fallback)},children:l=>(()=>{var i=I();return u(i,"draggable",!1),h(()=>u(i,"src",l())),i})()})),m(p,d(y,{get when(){return a.unread},get children(){return S()}}),null),h(l=>{var i=a.variant??"gray",b=a.src?"":void 0;return i!==l.e&&u(g,"data-variant",l.e=i),b!==l.t&&u(g,"data-has-image",l.t=b),l},{e:void 0,t:void 0}),p})()}var j=v("<div style=display:flex;gap:16px;align-items:center>");const C=`### Overview
Saturated 16px project avatar with color variants and optional unread dot.

### API
- Required: \`fallback\` string.
- Optional: \`src\`, \`variant\`, \`unread\`.

### Variants
- Color: orange, yellow, cyan, green, red, pink, blue, purple, gray.
- Outline: neutral, muted style for de-emphasized projects (e.g. recently closed).
- Image vs initial content state.
- Unread dot with corner mask when \`unread\` is set.

### Theming
- Uses \`--v2-avatar-bg-*\` and \`--v2-avatar-border-*\` tokens with inset box-shadow borders.
`,$={title:"UI V2/ProjectAvatar",id:"components-project-avatar-v2",component:A,tags:["autodocs"],parameters:{docs:{description:{component:C}}},argTypes:{variant:{control:"select",options:[...f,"outline"]}},args:{fallback:"O",variant:"orange"}},e={},t={args:{src:"https://placehold.co/32x32/png",fallback:"O",variant:"blue"}},n={render:()=>(()=>{var r=j();return m(r,d(O,{each:f,children:a=>d(A,{get fallback(){return a[0].toUpperCase()},variant:a})})),r})()},s={args:{fallback:"O",variant:"outline"}},o={args:{fallback:"O",variant:"orange",unread:!0}},c={render:()=>(()=>{var r=j();return m(r,d(O,{each:f,children:a=>d(A,{get fallback(){return a[0].toUpperCase()},variant:a,unread:!0})})),r})()};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => <ProjectAvatar fallback="O" variant="orange" />;
`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const WithImage = () => (
  <ProjectAvatar
    fallback="O"
    variant="blue"
    src="https://placehold.co/32x32/png"
  />
);
`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const AllVariants = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <For each={PROJECT_AVATAR_VARIANTS}>
      {(variant) => (
        <ProjectAvatar fallback={variant[0].toUpperCase()} variant={variant} />
      )}
    </For>
  </div>
);
`,...n.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Outline = () => <ProjectAvatar fallback="O" variant="outline" />;
`,...s.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Unread = () => <ProjectAvatar fallback="O" variant="orange" unread />;
`,...o.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const AllVariantsUnread = () => (
  <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
    <For each={PROJECT_AVATAR_VARIANTS}>
      {(variant) => (
        <ProjectAvatar
          fallback={variant[0].toUpperCase()}
          variant={variant}
          unread
        />
      )}
    </For>
  </div>
);
`,...c.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"{}",...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    src: "https://placehold.co/32x32/png",
    fallback: "O",
    variant: "blue"
  }
}`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <For each={PROJECT_AVATAR_VARIANTS}>
        {variant => <ProjectAvatar fallback={variant[0].toUpperCase()} variant={variant} />}
      </For>
    </div>
}`,...n.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    fallback: "O",
    variant: "outline"
  }
}`,...s.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    fallback: "O",
    variant: "orange",
    unread: true
  }
}`,...o.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "16px",
    "align-items": "center"
  }}>
      <For each={PROJECT_AVATAR_VARIANTS}>
        {variant => <ProjectAvatar fallback={variant[0].toUpperCase()} variant={variant} unread />}
      </For>
    </div>
}`,...c.parameters?.docs?.source}}};const E=["Basic","WithImage","AllVariants","Outline","Unread","AllVariantsUnread"];export{n as AllVariants,c as AllVariantsUnread,e as Basic,s as Outline,o as Unread,t as WithImage,E as __namedExportsOrder,$ as default};
