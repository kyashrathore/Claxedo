import{s as p,b as e,m as i,i as u,K as h,t as v,aa as A,L,S as M,W as k,c as w}from"./iframe-D288tw9h.js";import{I as y}from"./icon-button-C_HG_auw.js";import{T as C}from"./GCLC5SON-CkOBJroR.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./AGCGV7T6-D4ycykph.js";import"./LP6E37CW-BgXoIsgV.js";import"./SOM3K36D-DFQE1dRQ.js";import"./index-BSkhwO4U.js";var B=v("<div data-slot=tabs-trigger-wrapper>"),S=v("<div data-slot=tabs-trigger-close-button class=ui-tabs-trigger-close-button>"),z=v("<div data-slot=tabs-section-title>");function V(n){const[a,o]=p(n,["class","classList","variant","orientation"]);return e(C,i(o,{get orientation(){return a.orientation},"data-component":"tabs",get"data-variant"(){return a.variant||"normal"},get"data-orientation"(){return a.orientation||"horizontal"},get classList(){return{"ui-tabs":!0,...a.classList,[a.class??""]:!!a.class}}}))}function x(n){const[a,o]=p(n,["class","classList"]);return e(C.List,i(o,{"data-slot":"tabs-list",get classList(){return{"ui-tabs-list":!0,...a.classList,[a.class??""]:!!a.class}}}))}function O(n){const[a,o]=p(n,["class","classList","classes","children","closeButton","hideCloseButton","onMiddleClick"]);return(()=>{var s=B();return s.addEventListener("auxclick",r=>{r.button===1&&a.onMiddleClick&&(r.preventDefault(),a.onMiddleClick())}),s.$$mousedown=r=>{r.button===1&&a.onMiddleClick&&r.preventDefault()},u(s,e(C.Trigger,i(o,{"data-slot":"tabs-trigger",get"data-value"(){return n.value},get classList(){return{"ui-tabs-trigger":!0,[a.classes?.button??""]:a.classes?.button}},get children(){return a.children}})),null),u(s,e(M,{get when(){return a.closeButton},children:r=>(()=>{var g=S();return u(g,r),h(()=>L(g,"data-hidden",a.hideCloseButton)),g})()}),null),h(r=>{var g=n.value,f={"ui-tabs-trigger-wrapper":!0,...a.classList,[a.class??""]:!!a.class};return g!==r.e&&L(s,"data-value",r.e=g),r.t=k(s,f,r.t),r},{e:void 0,t:void 0}),s})()}function $(n){const[a,o]=p(n,["class","classList","children"]);return e(C.Content,i(o,{"data-slot":"tabs-content",get classList(){return{"ui-tabs-content":!0,...a.classList,[a.class??""]:!!a.class}},get children(){return a.children}}))}const _=n=>(()=>{var a=z();return u(a,()=>n.children),a})(),t=Object.assign(V,{List:x,Trigger:O,Content:$,SectionTitle:_});A(["mousedown"]);var D=v("<div style=display:grid;gap:8px><div style=font-size:12px;color:var(--text-weak)>");const G='### Overview\nTabbed navigation for switching between related panels.\n\nCompose `Tabs.List` + `Tabs.Trigger` + `Tabs.Content`.\n\n### API\n- Root accepts Kobalte Tabs props (`value`, `defaultValue`, `onChange`).\n- `variant` sets visual style: normal, alt, pill, settings.\n- `orientation` supports horizontal or vertical layouts.\n- Trigger supports `closeButton`, `hideCloseButton`, and `onMiddleClick`.\n\n### Variants and states\n- Normal, alt, pill, settings variants.\n- Horizontal and vertical orientations.\n\n### Behavior\n- Uses Kobalte Tabs for roving focus and selection management.\n\n### Accessibility\n- TODO: confirm keyboard interactions from Kobalte Tabs.\n\n### Theming/tokens\n- Uses `data-component="tabs"` with variant/orientation data attributes.\n\n',q={title:"UI/Tabs",id:"components-tabs",component:t,tags:["autodocs"],parameters:{docs:{description:{component:G}}},argTypes:{variant:{control:"select",options:["normal","alt","pill","settings"]},orientation:{control:"select",options:["horizontal","vertical"]}}},l={args:{variant:"normal",orientation:"horizontal",defaultValue:"overview"},render:n=>e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"overview",children:"Overview"}),e(t.Trigger,{value:"details",children:"Details"}),e(t.Trigger,{value:"activity",children:"Activity"})]}}),e(t.Content,{value:"overview",children:"Overview content"}),e(t.Content,{value:"details",children:"Details content"}),e(t.Content,{value:"activity",children:"Activity content"})]}}))},d={args:{variant:"settings",orientation:"horizontal",defaultValue:"general"},render:n=>e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"general",children:"General"}),e(t.Trigger,{value:"appearance",children:"Appearance"})]}}),e(t.Content,{value:"general",children:"General settings"}),e(t.Content,{value:"appearance",children:"Appearance settings"})]}}))},c={args:{variant:"alt",orientation:"horizontal",defaultValue:"first"},render:n=>e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"first",children:"First"}),e(t.Trigger,{value:"second",children:"Second"})]}}),e(t.Content,{value:"first",children:"Alt content"}),e(t.Content,{value:"second",children:"Alt content 2"})]}}))},b={args:{variant:"pill",orientation:"vertical",defaultValue:"alpha"},render:n=>e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"alpha",children:"Alpha"}),e(t.Trigger,{value:"beta",children:"Beta"})]}}),e(t.Content,{value:"alpha",children:"Alpha content"}),e(t.Content,{value:"beta",children:"Beta content"})]}}))},T={args:{variant:"normal",orientation:"horizontal",defaultValue:"tab-1"},render:n=>e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"tab-1",get closeButton(){return e(y,{icon:"close",size:"small",variant:"ghost","aria-label":"Close tab"})},children:"Tab 1"}),e(t.Trigger,{value:"tab-2",children:"Tab 2"})]}}),e(t.Content,{value:"tab-1",children:"Closable content"}),e(t.Content,{value:"tab-2",children:"Standard content"})]}}))},m={args:{variant:"normal",orientation:"horizontal",defaultValue:"tab-1"},render:n=>{const[a,o]=w("Middle click a tab");return(()=>{var s=D(),r=s.firstChild;return u(r,a),u(s,e(t,i(n,{get children(){return[e(t.List,{get children(){return[e(t.Trigger,{value:"tab-1",onMiddleClick:()=>o("Middle clicked tab-1"),children:"Tab 1"}),e(t.Trigger,{value:"tab-2",onMiddleClick:()=>o("Middle clicked tab-2"),children:"Tab 2"})]}}),e(t.Content,{value:"tab-1",children:"Tab 1 content"}),e(t.Content,{value:"tab-2",children:"Tab 2 content"})]}})),null),s})()}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const Basic = (props) => (
  <mod.Tabs {...props}>
    <mod.Tabs.List>
      <mod.Tabs.Trigger value="overview">Overview</mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="details">Details</mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="activity">Activity</mod.Tabs.Trigger>
    </mod.Tabs.List>
    <mod.Tabs.Content value="overview">Overview content</mod.Tabs.Content>
    <mod.Tabs.Content value="details">Details content</mod.Tabs.Content>
    <mod.Tabs.Content value="activity">Activity content</mod.Tabs.Content>
  </mod.Tabs>
);
`,...l.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Settings = (props) => (
  <mod.Tabs {...props}>
    <mod.Tabs.List>
      <mod.Tabs.Trigger value="general">General</mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="appearance">Appearance</mod.Tabs.Trigger>
    </mod.Tabs.List>
    <mod.Tabs.Content value="general">General settings</mod.Tabs.Content>
    <mod.Tabs.Content value="appearance">Appearance settings</mod.Tabs.Content>
  </mod.Tabs>
);
`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Alt = (props) => (
  <mod.Tabs {...props}>
    <mod.Tabs.List>
      <mod.Tabs.Trigger value="first">First</mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="second">Second</mod.Tabs.Trigger>
    </mod.Tabs.List>
    <mod.Tabs.Content value="first">Alt content</mod.Tabs.Content>
    <mod.Tabs.Content value="second">Alt content 2</mod.Tabs.Content>
  </mod.Tabs>
);
`,...c.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{code:`const Vertical = (props) => (
  <mod.Tabs {...props}>
    <mod.Tabs.List>
      <mod.Tabs.Trigger value="alpha">Alpha</mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="beta">Beta</mod.Tabs.Trigger>
    </mod.Tabs.List>
    <mod.Tabs.Content value="alpha">Alpha content</mod.Tabs.Content>
    <mod.Tabs.Content value="beta">Beta content</mod.Tabs.Content>
  </mod.Tabs>
);
`,...b.parameters?.docs?.source}}};T.parameters={...T.parameters,docs:{...T.parameters?.docs,source:{code:`const Closable = (props) => (
  <mod.Tabs {...props}>
    <mod.Tabs.List>
      <mod.Tabs.Trigger
        value="tab-1"
        closeButton={
          <IconButton
            icon="close"
            size="small"
            variant="ghost"
            aria-label="Close tab"
          />
        }
      >
        Tab 1
      </mod.Tabs.Trigger>
      <mod.Tabs.Trigger value="tab-2">Tab 2</mod.Tabs.Trigger>
    </mod.Tabs.List>
    <mod.Tabs.Content value="tab-1">Closable content</mod.Tabs.Content>
    <mod.Tabs.Content value="tab-2">Standard content</mod.Tabs.Content>
  </mod.Tabs>
);
`,...T.parameters?.docs?.source}}};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{code:`const MiddleClick = (props) => {
  const [message, setMessage] = createSignal("Middle click a tab");
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ "font-size": "12px", color: "var(--text-weak)" }}>
        {message()}
      </div>
      <mod.Tabs {...props}>
        <mod.Tabs.List>
          <mod.Tabs.Trigger
            value="tab-1"
            onMiddleClick={() => setMessage("Middle clicked tab-1")}
          >
            Tab 1
          </mod.Tabs.Trigger>
          <mod.Tabs.Trigger
            value="tab-2"
            onMiddleClick={() => setMessage("Middle clicked tab-2")}
          >
            Tab 2
          </mod.Tabs.Trigger>
        </mod.Tabs.List>
        <mod.Tabs.Content value="tab-1">Tab 1 content</mod.Tabs.Content>
        <mod.Tabs.Content value="tab-2">Tab 2 content</mod.Tabs.Content>
      </mod.Tabs>
    </div>
  );
};
`,...m.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "normal",
    orientation: "horizontal",
    defaultValue: "overview"
  },
  render: props => <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="overview">Overview</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="details">Details</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="activity">Activity</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="overview">Overview content</mod.Tabs.Content>
      <mod.Tabs.Content value="details">Details content</mod.Tabs.Content>
      <mod.Tabs.Content value="activity">Activity content</mod.Tabs.Content>
    </mod.Tabs>
}`,...l.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "settings",
    orientation: "horizontal",
    defaultValue: "general"
  },
  render: props => <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="general">General</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="appearance">Appearance</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="general">General settings</mod.Tabs.Content>
      <mod.Tabs.Content value="appearance">Appearance settings</mod.Tabs.Content>
    </mod.Tabs>
}`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "alt",
    orientation: "horizontal",
    defaultValue: "first"
  },
  render: props => <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="first">First</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="second">Second</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="first">Alt content</mod.Tabs.Content>
      <mod.Tabs.Content value="second">Alt content 2</mod.Tabs.Content>
    </mod.Tabs>
}`,...c.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "pill",
    orientation: "vertical",
    defaultValue: "alpha"
  },
  render: props => <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="alpha">Alpha</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="beta">Beta</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="alpha">Alpha content</mod.Tabs.Content>
      <mod.Tabs.Content value="beta">Beta content</mod.Tabs.Content>
    </mod.Tabs>
}`,...b.parameters?.docs?.source}}};T.parameters={...T.parameters,docs:{...T.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "normal",
    orientation: "horizontal",
    defaultValue: "tab-1"
  },
  render: props => <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="tab-1" closeButton={<IconButton icon="close" size="small" variant="ghost" aria-label="Close tab" />}>
          Tab 1
        </mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="tab-2">Tab 2</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="tab-1">Closable content</mod.Tabs.Content>
      <mod.Tabs.Content value="tab-2">Standard content</mod.Tabs.Content>
    </mod.Tabs>
}`,...T.parameters?.docs?.source}}};m.parameters={...m.parameters,docs:{...m.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "normal",
    orientation: "horizontal",
    defaultValue: "tab-1"
  },
  render: props => {
    const [message, setMessage] = createSignal("Middle click a tab");
    return <div style={{
      display: "grid",
      gap: "8px"
    }}>
        <div style={{
        "font-size": "12px",
        color: "var(--text-weak)"
      }}>{message()}</div>
        <mod.Tabs {...props}>
          <mod.Tabs.List>
            <mod.Tabs.Trigger value="tab-1" onMiddleClick={() => setMessage("Middle clicked tab-1")}>
              Tab 1
            </mod.Tabs.Trigger>
            <mod.Tabs.Trigger value="tab-2" onMiddleClick={() => setMessage("Middle clicked tab-2")}>
              Tab 2
            </mod.Tabs.Trigger>
          </mod.Tabs.List>
          <mod.Tabs.Content value="tab-1">Tab 1 content</mod.Tabs.Content>
          <mod.Tabs.Content value="tab-2">Tab 2 content</mod.Tabs.Content>
        </mod.Tabs>
      </div>;
  }
}`,...m.parameters?.docs?.source}}};const J=["Basic","Settings","Alt","Vertical","Closable","MiddleClick"];export{c as Alt,l as Basic,T as Closable,m as MiddleClick,d as Settings,b as Vertical,J as __namedExportsOrder,q as default};
