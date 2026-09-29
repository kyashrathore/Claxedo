import{d as ie,e as A,s as I,c as D,w as ce,y as le,r as de,b as s,m as f,x as U,g as F,B as j,a as T,P as E,aH as pe,aI as ue,aG as ge,l as fe,j as me,k as B,_ as ve,n as $,a2 as Oe,h as he,S,a1 as Pe,X as H,a0 as Ce,p as _,q as Ie,Z as ye,aD as k,i as M,t as q}from"./iframe-D288tw9h.js";import{P as G,a as K}from"./OGE3DKII-BkPGJFio.js";import{u as be}from"./i18n-CW9P7x91.js";import{I as we}from"./icon-button-C_HG_auw.js";import{c as De}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./LP6E37CW-BgXoIsgV.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var Re={};ve(Re,{Anchor:()=>z,Arrow:()=>G,CloseButton:()=>W,Content:()=>X,Description:()=>Z,Popover:()=>v,Portal:()=>J,Root:()=>Q,Title:()=>Y,Trigger:()=>ee,usePopoverContext:()=>y});var V=fe();function y(){const a=me(V);if(a===void 0)throw new Error("[kobalte]: `usePopoverContext` must be used within a `Popover` component");return a}function z(a){const t=y(),[e,o]=I(a,["ref"]);return s(E,f({as:"div",ref(i){var l=F(t.setDefaultAnchorRef,e.ref);typeof l=="function"&&l(i)}},()=>t.dataset(),o))}function W(a){const t=y(),[e,o]=I(a,["aria-label","onClick"]);return s(j,f({get"aria-label"(){return e["aria-label"]||t.translations().dismiss},onClick:l=>{B(l,e.onClick),t.close()}},()=>t.dataset(),o))}function X(a){let t;const e=y(),o=A({id:e.generateId("content")},a),[i,l]=I(o,["ref","style","onOpenAutoFocus","onCloseAutoFocus","onPointerDownOutside","onFocusOutside","onInteractOutside"]);let d=!1,p=!1,m=!1;const b=n=>{i.onCloseAutoFocus?.(n),e.isModal()?(n.preventDefault(),d||H(e.triggerRef())):(n.defaultPrevented||(p||H(e.triggerRef()),n.preventDefault()),p=!1,m=!1)},r=n=>{i.onPointerDownOutside?.(n),e.isModal()&&(d=n.detail.isContextMenu)},w=n=>{i.onFocusOutside?.(n),e.isOpen()&&e.isModal()&&n.preventDefault()},x=n=>{i.onInteractOutside?.(n),!e.isModal()&&(n.defaultPrevented||(p=!0,n.detail.originalEvent.type==="pointerdown"&&(m=!0)),Ce(e.triggerRef(),n.target)&&n.preventDefault(),n.detail.originalEvent.type==="focusin"&&m&&n.preventDefault())};return pe({isDisabled:()=>!(e.isOpen()&&e.isModal()),targets:()=>t?[t]:[]}),ue({element:()=>t??null,enabled:()=>e.contentPresent()&&e.preventScroll()}),ge({trapFocus:()=>e.isOpen()&&e.isModal(),onMountAutoFocus:i.onOpenAutoFocus,onUnmountAutoFocus:b},()=>t),T(()=>$(e.registerContentId(l.id))),s(S,{get when(){return e.contentPresent()},get children(){return s(K.Positioner,{get children(){return s(Oe,f({ref(n){var R=F(c=>{e.setContentRef(c),t=c},i.ref);typeof R=="function"&&R(n)},role:"dialog",tabIndex:-1,get disableOutsidePointerEvents(){return U(()=>!!e.isOpen())()&&e.isModal()},get excludedElements(){return[e.triggerRef]},get style(){return he({"--kb-popover-content-transform-origin":"var(--kb-popper-content-transform-origin)",position:"relative"},i.style)},get"aria-labelledby"(){return e.titleId()},get"aria-describedby"(){return e.descriptionId()},onPointerDownOutside:r,onFocusOutside:w,onInteractOutside:x,get onDismiss(){return e.close}},()=>e.dataset(),l))}})}})}function Z(a){const t=y(),e=A({id:t.generateId("description")},a),[o,i]=I(e,["id"]);return T(()=>$(t.registerDescriptionId(o.id))),s(E,f({as:"p",get id(){return o.id}},()=>t.dataset(),i))}function J(a){const t=y();return s(S,{get when(){return t.contentPresent()},get children(){return s(Pe,a)}})}var L={dismiss:"Dismiss"};function Q(a){const t=`popover-${ie()}`,e=A({id:t,modal:!1,translations:L},a),[o,i]=I(e,["translations","id","open","defaultOpen","onOpenChange","modal","preventScroll","forceMount","anchorRef"]),[l,d]=D(),[p,m]=D(),[b,r]=D(),[w,x]=D(),[n,R]=D(),[c,u]=D(),g=ce({open:()=>o.open,defaultOpen:()=>o.defaultOpen,onOpenChange:ae=>o.onOpenChange?.(ae)}),ne=()=>o.anchorRef?.()??l()??p(),{present:re}=le({show:()=>o.forceMount||g.isOpen(),element:()=>b()??null}),se=de(()=>({"data-expanded":g.isOpen()?"":void 0,"data-closed":g.isOpen()?void 0:""})),N={translations:()=>o.translations??L,dataset:se,isOpen:g.isOpen,isModal:()=>o.modal??!1,preventScroll:()=>o.preventScroll??N.isModal(),contentPresent:re,triggerRef:p,contentId:w,titleId:n,descriptionId:c,setDefaultAnchorRef:d,setTriggerRef:m,setContentRef:r,close:g.close,toggle:g.toggle,generateId:Ie(()=>o.id),registerContentId:_(x),registerTitleId:_(R),registerDescriptionId:_(u)};return s(V.Provider,{value:N,get children(){return s(K,f({anchorRef:ne,contentRef:b},i))}})}function Y(a){const t=y(),e=A({id:t.generateId("title")},a),[o,i]=I(e,["id"]);return T(()=>$(t.registerTitleId(o.id))),s(E,f({as:"h2",get id(){return o.id}},()=>t.dataset(),i))}function ee(a){const t=y(),[e,o]=I(a,["ref","onClick","onPointerDown"]);return s(j,f({ref(d){var p=F(t.setTriggerRef,e.ref);typeof p=="function"&&p(d)},"aria-haspopup":"dialog",get"aria-expanded"(){return t.isOpen()},get"aria-controls"(){return U(()=>!!t.isOpen())()?t.contentId():void 0},onPointerDown:d=>{B(d,e.onPointerDown),d.preventDefault()},onClick:d=>{B(d,e.onClick),t.toggle()}},()=>t.dataset(),o))}var v=Object.assign(Q,{Anchor:z,Arrow:G,CloseButton:W,Content:X,Description:Z,Portal:J,Title:Y,Trigger:ee}),xe=q("<div data-slot=popover-header>"),Se=q("<div data-slot=popover-body class=ui-popover-body>");function te(a){const t=be(),[e,o]=I(a,["trigger","triggerAs","triggerProps","title","description","class","classList","style","children","portal","open","defaultOpen","onOpenChange","modal"]),[i,l]=ye({contentRef:void 0,triggerRef:void 0,dismiss:null,uncontrolledOpen:e.defaultOpen??!1}),d=()=>e.open!==void 0,p=()=>d()?e.open??!1:i.uncontrolledOpen,m=r=>{r&&l("dismiss",null),e.onOpenChange&&e.onOpenChange(r),!d()&&l("uncontrolledOpen",r)};T(()=>{if(!p())return;const r=c=>{if(!c)return!1;const u=i.contentRef;if(u&&u.contains(c))return!0;const g=i.triggerRef;return!!(g&&g.contains(c))},w=c=>{l("dismiss",c),m(!1)},x=c=>{c.key==="Escape"&&(w("escape"),c.preventDefault(),c.stopPropagation())},n=c=>{const u=c.target;u instanceof Node&&(r(u)||w("outside"))},R=c=>{const u=c.target;u instanceof Node&&(r(u)||w("outside"))};k(window,"keydown",x,{capture:!0}),k(window,"pointerdown",n,{capture:!0}),k(window,"focusin",R,{capture:!0})});const b=()=>s(v.Content,{ref:r=>l("contentRef",r),"data-component":"popover-content",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get style(){return e.style},onCloseAutoFocus:r=>{i.dismiss==="outside"&&r.preventDefault(),l("dismiss",null)},get children(){return[s(S,{get when(){return e.title},get children(){var r=xe();return M(r,s(v.Title,{"data-slot":"popover-title",get children(){return e.title}}),null),M(r,s(v.CloseButton,{"data-slot":"popover-close-button",as:we,icon:"close",variant:"ghost",get"aria-label"(){return t.t("ui.common.close")}}),null),r}}),s(S,{get when(){return e.description},get children(){return s(v.Description,{"data-slot":"popover-description",get children(){return e.description}})}}),(()=>{var r=Se();return M(r,()=>e.children),r})()]}});return s(v,f({gutter:4},o,{get open(){return p()},onOpenChange:m,get modal(){return e.modal??!1},get children(){return[s(v.Trigger,f({ref:r=>l("triggerRef",r),get as(){return e.triggerAs??"div"},"data-slot":"popover-trigger"},()=>e.triggerProps,{get children(){return e.trigger}})),s(S,{get when(){return e.portal??!0},get fallback(){return b()},get children(){return s(v.Portal,{get children(){return b()}})}})]}}))}const Ae=Object.freeze(Object.defineProperty({__proto__:null,Popover:te},Symbol.toStringTag,{value:"Module"})),Te=`### Overview
Composable popover with optional title, description, and close button.

Use for small contextual details; avoid long forms.

### API
- \`trigger\` and \`children\` define the anchor and content.
- Optional: \`title\`, \`description\`, \`portal\`, \`open\`, \`defaultOpen\`.

### Variants and states
- Supports controlled and uncontrolled open state.

### Behavior
- Closes on outside click or Escape by default.

### Accessibility
- TODO: confirm focus management from Kobalte.

### Theming/tokens
- Uses \`data-component="popover-content"\` and related slots.

`,oe=De({title:"UI/Popover",mod:Ae,args:{trigger:"Open popover",title:"Popover",description:"Optional description",defaultOpen:!0,children:"Popover content"}}),Ue={title:"UI/Popover",id:"components-popover",component:oe.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:Te}}}},O=oe.Basic,h={args:{title:void 0,description:void 0,children:"Popover body only"}},P={args:{portal:!1,defaultOpen:!0}},C={render:()=>{const[a,t]=D(!0);return s(te,{get open(){return a()},onOpenChange:t,trigger:"Toggle popover",title:"Controlled",description:"Open state is controlled",children:"Controlled content"})}};O.parameters={...O.parameters,docs:{...O.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  53 | }
  54 |
> 55 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  56 |
  57 | export const NoHeader = {
  58 |   args: {`,...O.parameters?.docs?.source}}};h.parameters={...h.parameters,docs:{...h.parameters?.docs,source:{code:`const NoHeader = () => (
  <story.meta.component title={undefined} description={undefined}>
    Popover body only
  </story.meta.component>
);
`,...h.parameters?.docs?.source}}};P.parameters={...P.parameters,docs:{...P.parameters?.docs,source:{code:`const Inline = () => <story.meta.component portal={false} defaultOpen />;
`,...P.parameters?.docs?.source}}};C.parameters={...C.parameters,docs:{...C.parameters?.docs,source:{code:`const Controlled = () => {
  const [open, setOpen] = createSignal(true);
  return (
    <mod.Popover
      open={open()}
      onOpenChange={setOpen}
      trigger="Toggle popover"
      title="Controlled"
      description="Open state is controlled"
    >
      Controlled content
    </mod.Popover>
  );
};
`,...C.parameters?.docs?.source}}};O.parameters={...O.parameters,docs:{...O.parameters?.docs,source:{originalSource:"story.Basic",...O.parameters?.docs?.source}}};h.parameters={...h.parameters,docs:{...h.parameters?.docs,source:{originalSource:`{
  args: {
    title: undefined,
    description: undefined,
    children: "Popover body only"
  }
}`,...h.parameters?.docs?.source}}};P.parameters={...P.parameters,docs:{...P.parameters?.docs,source:{originalSource:`{
  args: {
    portal: false,
    defaultOpen: true
  }
}`,...P.parameters?.docs?.source}}};C.parameters={...C.parameters,docs:{...C.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [open, setOpen] = createSignal(true);
    return <mod.Popover open={open()} onOpenChange={setOpen} trigger="Toggle popover" title="Controlled" description="Open state is controlled">
        Controlled content
      </mod.Popover>;
  }
}`,...C.parameters?.docs?.source}}};const je=["Basic","NoHeader","Inline","Controlled"];export{O as Basic,C as Controlled,P as Inline,h as NoHeader,je as __namedExportsOrder,Ue as default};
