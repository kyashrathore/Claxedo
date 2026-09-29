import{Z as ae,a as G,z as ve,i as o,b as i,ad as ce,K as C,t as u,S as g,W as j,V as le,x as N,L as W,aa as ke,aD as be}from"./iframe-D288tw9h.js";import{u as Ae}from"./i18n-CW9P7x91.js";import{I as V}from"./icon-BG5j3Qjr.js";import{I as we}from"./icon-button-C_HG_auw.js";import{T as $e}from"./text-field-aUCYYfm_.js";import{u as Le}from"./use-filtered-list-XOqX6bHa.js";import{c as _e}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./NGHEENNE-Dk4g74Tj.js";import"./ZZYKR3VO-DWSPmSPl.js";import"./tooltip-3OGsQ03U.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./map-B72Trknd.js";var Te=u("<div data-slot=list-item-add>"),Be=u("<div data-slot=list-header class=ui-list-header>"),de=u("<span>"),xe=u("<span data-slot=list-filter>&quot;<!>&quot;"),Se=u("<div data-slot=list-search-wrapper class=ui-list-search-wrapper><div data-slot=list-search><div data-slot=list-search-container>"),me=u("<div data-slot=list-group><div data-slot=list-items>"),Ge=u("<div data-component=list><div data-slot=list-scroll class=ui-list-scroll>"),Ie=u("<div data-slot=list-empty-state><div data-slot=list-message>"),Oe=u("<span data-slot=list-item-selected-icon class=ui-list-item-selected-icon>"),Fe=u("<button data-slot=list-item class=ui-list-item type=button>"),Ce=u("<span data-slot=list-item-active-icon class=ui-list-item-active-icon>"),Ee=u("<span data-slot=list-item-divider class=ui-list-item-divider>");function ue(e,a){const h=e.querySelectorAll('[data-slot="list-item"][data-key]');for(const x of h)if(x.getAttribute("data-key")===a)return x}function f(e){const a=Ae();let h;const[x,E]=ae({mouseActive:!1,scrollRef:void 0,internalFilter:""}),R=()=>x.scrollRef,X=t=>E("scrollRef",t),D=()=>x.internalFilter,q=t=>E("internalFilter",t),Y=(t,s,r)=>{const n=t.getBoundingClientRect(),c=s.getBoundingClientRect(),l=c.top-n.top+t.scrollTop;l+c.height,t.scrollTop+t.clientHeight;const d=l-t.clientHeight/2+c.height/2,O=Math.max(0,t.scrollHeight-t.clientHeight);t.scrollTop=Math.max(0,Math.min(d,O))},{filter:U,grouped:H,flat:K,active:I,setActive:Z,onKeyDown:z,onInput:J,refetch:Q}=Le(e),S=()=>typeof e.search=="object"?e.search:{},he=()=>S().action,ee=()=>e.add,M=()=>!!ee(),ge=t=>t.movementX!==0||t.movementY!==0,te=(t,s)=>{const r=U();if(q(t),J(t),e.onFilter?.(t),!!s?.ref){if(r===t){Q();return}queueMicrotask(()=>Q())}};G(()=>{e.filter!==void 0&&e.filter!==D()&&(q(e.filter),J(e.filter))}),G(ve(U,()=>{R()?.scrollTo(0,0)},{defer:!0})),G(()=>{const t=R();if(!t||!e.current)return;const s=e.key(e.current);requestAnimationFrame(()=>{const r=ue(t,s);r&&Y(t,r)})}),G(()=>{const t=K();if(x.mouseActive||t.length===0)return;const s=R();if(!s)return;if(I()===e.key(t[0])){s.scrollTo(0,0);return}const r=I();if(!r)return;const n=ue(s,r);n&&Y(s,n)}),G(()=>{const t=K(),s=I(),r=t.find(n=>e.key(n)===s);e.onMove?.(r)});const re=(t,s)=>{e.onSelect?.(t,s)},P=t=>{if(E("mouseActive",!1),t.key==="Escape")return;const s=K(),r=s.find(c=>e.key(c)===I()),n=r?s.indexOf(r):-1;if(e.onKeyEvent?.(t,r),!t.defaultPrevented)if(t.key==="Enter"&&!t.isComposing)t.preventDefault(),r&&re(r,n);else if(e.search){if(t.ctrlKey&&!t.metaKey&&!t.altKey&&!t.shiftKey&&(t.key==="n"||t.key==="p")){z(t);return}(t.key==="ArrowDown"||t.key==="ArrowUp")&&z(t)}else z(t)};e.ref?.({onKeyDown:P,setScrollRef:X,setFilter:t=>te(t,{ref:!0})});const ne=()=>{const t=ee();return t?(()=>{var s=Te();return o(s,()=>t.render()),C(r=>j(s,{"ui-list-item-add":!0,[t.class??""]:!!t.class},r)),s})():null};function fe(t){const[s,r]=ae({stuck:!1,header:void 0});return G(()=>{const n=R(),c=s.header;if(!n||!c)return;const l=()=>{const y=c.getBoundingClientRect(),d=n.getBoundingClientRect();r("stuck",y.top<=d.top+1&&n.scrollTop>0)};be(n,"scroll",l,{passive:!0}),l()}),(()=>{var n=Be();return ce(c=>r("header",c),n),o(n,()=>e.groupHeader?.(t.group)??t.group.category),C(()=>W(n,"data-stuck",s.stuck)),n})()}const ye=()=>{if(H.loading)return e.loadingMessage??a.t("ui.list.loading");if(e.emptyMessage)return e.emptyMessage;const t=U();if(!t)return a.t("ui.list.empty");const s=a.t("ui.list.emptyWithFilter.suffix");return[(()=>{var r=de();return o(r,()=>a.t("ui.list.emptyWithFilter.prefix")),r})(),(()=>{var r=xe(),n=r.firstChild,c=n.nextSibling;return c.nextSibling,o(r,t,c),r})(),i(g,{when:s,get children(){var r=de();return o(r,s),r}})]};return(()=>{var t=Ge(),s=t.firstChild;return o(t,i(g,{get when(){return!!e.search},get children(){var r=Se(),n=r.firstChild,c=n.firstChild;return n.$$pointerdown=l=>{const y=l.currentTarget;if(!(y instanceof HTMLElement))return;const d=y.querySelector("input, textarea");(d instanceof HTMLInputElement||d instanceof HTMLTextAreaElement?d:h)?.focus(),l.stopPropagation()},o(c,i(g,{get when(){return!S().hideIcon},get children(){return i(V,{name:"magnifying-glass"})}}),null),o(c,i($e,{get autofocus(){return S().autofocus},variant:"ghost","data-slot":"list-search-input",type:"text",ref:l=>{h=l},get value(){return D()},onChange:l=>te(l),onKeyDown:P,get placeholder(){return S().placeholder},spellcheck:!1,autocorrect:"off",autocomplete:"off",autocapitalize:"off"}),null),o(n,i(g,{get when(){return D()},get children(){return i(we,{icon:"circle-x",variant:"ghost",onClick:()=>{q(""),queueMicrotask(()=>h?.focus())},get"aria-label"(){return a.t("ui.list.clearFilter")}})}}),null),o(n,he,null),C(l=>j(n,{"ui-list-search":!0,[S().class??""]:!!S().class},l)),r}}),s),ce(X,s),o(s,i(g,{get when(){return K().length>0||M()},get fallback(){return(()=>{var r=Ie(),n=r.firstChild;return o(n,ye),r})()},get children(){return[i(le,{get each(){return H.latest},children:(r,n)=>{const c=()=>n()===H.latest.length-1;return(()=>{var l=me(),y=l.firstChild;return o(l,i(g,{get when(){return r.category},get children(){return i(fe,{group:r})}}),y),o(y,i(le,{get each(){return r.items},children:(d,O)=>{const se=(()=>{var p=Fe();return p.addEventListener("mouseleave",()=>{x.mouseActive&&Z(null)}),p.$$mousemove=m=>{ge(m)&&(E("mouseActive",!0),Z(e.key(d)))},p.$$keydown=P,p.$$click=()=>re(d,O()),o(p,()=>e.children(d),null),o(p,i(g,{get when(){return d===e.current},get children(){var m=Oe();return o(m,i(V,{name:"check-small"})),m}}),null),o(p,i(g,{get when(){return e.activeIcon},children:m=>(()=>{var F=Ce();return o(F,i(V,{get name(){return m()}})),F})()}),null),o(p,(()=>{var m=N(()=>!!(e.divider&&(O()!==r.items.length-1||M()&&c())));return()=>m()&&Ee()})(),null),C(m=>{var F=e.key(d),ie=e.key(d)===I(),oe=d===e.current;return F!==m.e&&W(p,"data-key",m.e=F),ie!==m.t&&W(p,"data-active",m.t=ie),oe!==m.a&&W(p,"data-selected",m.a=oe),m},{e:void 0,t:void 0,a:void 0}),p})();return e.itemWrapper?e.itemWrapper(d,se):se}}),null),o(y,i(g,{get when(){return N(()=>!!M())()&&c()},get children(){return ne()}}),null),l})()}}),i(g,{get when(){return N(()=>H.latest.length===0)()&&M()},get children(){var r=me(),n=r.firstChild;return o(n,ne),r}})]}})),C(r=>j(t,{"ui-list":!0,[e.class??""]:!!e.class},r)),t})()}ke(["pointerdown","click","keydown","mousemove"]);const Re=Object.freeze(Object.defineProperty({__proto__:null,List:f},Symbol.toStringTag,{value:"Module"}));var He=u("<button type=button data-slot=list-item>Add item"),Ke=u("<button type=button>Action"),Me=u('<div style="border:1px solid var(--border-weak);border-radius:6px;margin:4px 0">'),We=u("<strong>");const De=`### Overview
Filterable list with keyboard navigation and optional search input.

Use within panels or popovers where keyboard navigation is expected.

### API
- Required: \`items\` and \`key\`.
- Required: \`children\` render function for items.
- Optional: \`search\`, \`filterKeys\`, \`groupBy\`, \`onSelect\`, \`onKeyEvent\`.

### Variants and states
- Optional search bar and group headers.

### Behavior
- Uses fuzzy search when \`search\` is enabled.
- Keyboard navigation via arrow keys; Enter selects.

### Accessibility
- TODO: confirm ARIA roles for list items and search input.

### Theming/tokens
- Uses \`data-component="list"\` and data slots for structure.

`,pe=_e({title:"UI/List",mod:Re,args:{items:["One","Two","Three","Four"],key:e=>e,children:e=>e,search:!0}}),it={title:"UI/List",id:"components-list",component:pe.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:De}}}},v=pe.Basic,k={render:()=>i(f,{items:[{id:"a1",title:"Alpha",group:"Group A"},{id:"a2",title:"Bravo",group:"Group A"},{id:"b1",title:"Delta",group:"Group B"}],key:a=>a.id,groupBy:a=>a.group,search:!0,children:a=>a.title})},b={render:()=>i(f,{items:[],key:e=>e,search:!0,children:e=>e})},A={render:()=>i(f,{items:["One","Two"],key:e=>e,search:!0,add:{render:()=>He()},children:e=>e})},w={render:()=>i(f,{items:["One","Two","Three"],key:e=>e,divider:!0,children:e=>e})},$={render:()=>i(f,{items:["Alpha","Beta","Gamma"],key:e=>e,activeIcon:"chevron-right",children:e=>e})},L={render:()=>i(f,{items:["One","Two","Three"],key:e=>e,search:!1,children:e=>e})},_={render:()=>i(f,{items:["Apple","Banana","Cherry"],key:e=>e,get search(){return{placeholder:"Filter...",hideIcon:!0,action:Ke()}},children:e=>e})},T={render:()=>i(f,{items:["One","Two","Three"],key:e=>e,itemWrapper:(e,a)=>(()=>{var h=Me();return o(h,a),h})(),children:e=>e})},B={render:()=>i(f,{items:[{id:"a1",title:"Alpha",group:"Group A"},{id:"b1",title:"Beta",group:"Group B"}],key:a=>a.id,groupBy:a=>a.group,groupHeader:a=>(()=>{var h=We();return o(h,()=>a.category),h})(),children:a=>a.title})};v.parameters={...v.parameters,docs:{...v.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  53 | }
  54 |
> 55 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  56 |
  57 | export const Grouped = {
  58 |   render: () => {`,...v.parameters?.docs?.source}}};k.parameters={...k.parameters,docs:{...k.parameters?.docs,source:{code:`const Grouped = () => {
  const items = [
    { id: "a1", title: "Alpha", group: "Group A" },
    { id: "a2", title: "Bravo", group: "Group A" },
    { id: "b1", title: "Delta", group: "Group B" },
  ];
  return (
    <mod.List
      items={items}
      key={(item) => item.id}
      groupBy={(item) => item.group}
      search={true}
    >
      {(item) => item.title}
    </mod.List>
  );
};
`,...k.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{code:`const Empty = () => (
  <mod.List items={[]} key={(item) => item} search={true}>
    {(item) => item}
  </mod.List>
);
`,...b.parameters?.docs?.source}}};A.parameters={...A.parameters,docs:{...A.parameters?.docs,source:{code:`const WithAdd = () => (
  <mod.List
    items={["One", "Two"]}
    key={(item) => item}
    search={true}
    add={{
      render: () => (
        <button type="button" data-slot="list-item">
          Add item
        </button>
      ),
    }}
  >
    {(item) => item}
  </mod.List>
);
`,...A.parameters?.docs?.source}}};w.parameters={...w.parameters,docs:{...w.parameters?.docs,source:{code:`const Divider = () => (
  <mod.List items={["One", "Two", "Three"]} key={(item) => item} divider={true}>
    {(item) => item}
  </mod.List>
);
`,...w.parameters?.docs?.source}}};$.parameters={...$.parameters,docs:{...$.parameters?.docs,source:{code:`const ActiveIcon = () => (
  <mod.List
    items={["Alpha", "Beta", "Gamma"]}
    key={(item) => item}
    activeIcon="chevron-right"
  >
    {(item) => item}
  </mod.List>
);
`,...$.parameters?.docs?.source}}};L.parameters={...L.parameters,docs:{...L.parameters?.docs,source:{code:`const NoSearch = () => (
  <mod.List items={["One", "Two", "Three"]} key={(item) => item} search={false}>
    {(item) => item}
  </mod.List>
);
`,...L.parameters?.docs?.source}}};_.parameters={..._.parameters,docs:{..._.parameters?.docs,source:{code:`const SearchOptions = () => (
  <mod.List
    items={["Apple", "Banana", "Cherry"]}
    key={(item) => item}
    search={{
      placeholder: "Filter...",
      hideIcon: true,
      action: <button type="button">Action</button>,
    }}
  >
    {(item) => item}
  </mod.List>
);
`,..._.parameters?.docs?.source}}};T.parameters={...T.parameters,docs:{...T.parameters?.docs,source:{code:`const ItemWrapper = () => (
  <mod.List
    items={["One", "Two", "Three"]}
    key={(item) => item}
    itemWrapper={(item, node) => (
      <div
        style={{
          border: "1px solid var(--border-weak)",
          "border-radius": "6px",
          margin: "4px 0",
        }}
      >
        {node}
      </div>
    )}
  >
    {(item) => item}
  </mod.List>
);
`,...T.parameters?.docs?.source}}};B.parameters={...B.parameters,docs:{...B.parameters?.docs,source:{code:`const GroupHeader = () => {
  const items = [
    { id: "a1", title: "Alpha", group: "Group A" },
    { id: "b1", title: "Beta", group: "Group B" },
  ];
  return (
    <mod.List
      items={items}
      key={(item) => item.id}
      groupBy={(item) => item.group}
      groupHeader={(group) => <strong>{group.category}</strong>}
    >
      {(item) => item.title}
    </mod.List>
  );
};
`,...B.parameters?.docs?.source}}};v.parameters={...v.parameters,docs:{...v.parameters?.docs,source:{originalSource:"story.Basic",...v.parameters?.docs?.source}}};k.parameters={...k.parameters,docs:{...k.parameters?.docs,source:{originalSource:`{
  render: () => {
    const items = [{
      id: "a1",
      title: "Alpha",
      group: "Group A"
    }, {
      id: "a2",
      title: "Bravo",
      group: "Group A"
    }, {
      id: "b1",
      title: "Delta",
      group: "Group B"
    }];
    return <mod.List items={items} key={item => item.id} groupBy={item => item.group} search={true}>
        {item => item.title}
      </mod.List>;
  }
}`,...k.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={[]} key={item => item} search={true}>
      {item => item}
    </mod.List>
}`,...b.parameters?.docs?.source}}};A.parameters={...A.parameters,docs:{...A.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["One", "Two"]} key={item => item} search={true} add={{
    render: () => <button type="button" data-slot="list-item">
            Add item
          </button>
  }}>
      {item => item}
    </mod.List>
}`,...A.parameters?.docs?.source}}};w.parameters={...w.parameters,docs:{...w.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["One", "Two", "Three"]} key={item => item} divider={true}>
      {item => item}
    </mod.List>
}`,...w.parameters?.docs?.source}}};$.parameters={...$.parameters,docs:{...$.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["Alpha", "Beta", "Gamma"]} key={item => item} activeIcon="chevron-right">
      {item => item}
    </mod.List>
}`,...$.parameters?.docs?.source}}};L.parameters={...L.parameters,docs:{...L.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["One", "Two", "Three"]} key={item => item} search={false}>
      {item => item}
    </mod.List>
}`,...L.parameters?.docs?.source}}};_.parameters={..._.parameters,docs:{..._.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["Apple", "Banana", "Cherry"]} key={item => item} search={{
    placeholder: "Filter...",
    hideIcon: true,
    action: <button type="button">Action</button>
  }}>
      {item => item}
    </mod.List>
}`,..._.parameters?.docs?.source}}};T.parameters={...T.parameters,docs:{...T.parameters?.docs,source:{originalSource:`{
  render: () => <mod.List items={["One", "Two", "Three"]} key={item => item} itemWrapper={(item, node) => <div style={{
    border: "1px solid var(--border-weak)",
    "border-radius": "6px",
    margin: "4px 0"
  }}>{node}</div>}>
      {item => item}
    </mod.List>
}`,...T.parameters?.docs?.source}}};B.parameters={...B.parameters,docs:{...B.parameters?.docs,source:{originalSource:`{
  render: () => {
    const items = [{
      id: "a1",
      title: "Alpha",
      group: "Group A"
    }, {
      id: "b1",
      title: "Beta",
      group: "Group B"
    }];
    return <mod.List items={items} key={item => item.id} groupBy={item => item.group} groupHeader={group => <strong>{group.category}</strong>}>
        {item => item.title}
      </mod.List>;
  }
}`,...B.parameters?.docs?.source}}};const ot=["Basic","Grouped","Empty","WithAdd","Divider","ActiveIcon","NoSearch","SearchOptions","ItemWrapper","GroupHeader"];export{$ as ActiveIcon,v as Basic,w as Divider,b as Empty,B as GroupHeader,k as Grouped,T as ItemWrapper,L as NoSearch,_ as SearchOptions,A as WithAdd,ot as __namedExportsOrder,it as default};
