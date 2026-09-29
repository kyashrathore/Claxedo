import{b as n,m,I as k,i as s,t as p,aa as S,a1 as B,S as g,x as u}from"./iframe-D288tw9h.js";import{T as l,t as f}from"./6TDKM7BK-viiLtHP4.js";import{u as R}from"./i18n-CW9P7x91.js";import{I as C}from"./icon-BG5j3Qjr.js";import{I as $}from"./icon-button-C_HG_auw.js";import{B as v}from"./button-Bsz0PTzb.js";import"./preload-helper-D9Z9MdNV.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var b=p("<div data-slot=toast-icon>"),_=p("<div data-slot=toast-content>"),P=p("<span data-slot=toast-title-icon aria-hidden=true>"),I=p("<div data-slot=toast-title-row>"),x=p("<div data-slot=toast-actions>"),A=p("<button data-slot=toast-action>");function L(t){return n(B,{get children(){return n(l.Region,m({"data-component":"toast-region"},t,{get children(){return n(l.List,{"data-slot":"toast-list"})}}))}})}function O(t){return n(l,m({"data-component":"toast",get classList(){return{"ui-toast":!0,...t.classList,[t.class??""]:!!t.class}}},t))}function U(t){return(()=>{var e=b();return s(e,n(C,{get name(){return t.name}})),e})()}function D(t){return(()=>{var e=_();return k(e,t,!1,!1),e})()}function F(t){return n(l.Title,m({"data-slot":"toast-title"},t))}function V(t){return(()=>{var e=I();return s(e,n(g,{get when(){return t.icon},get children(){var r=P();return s(r,n(C,{get name(){return t.icon},size:"small"})),r}}),null),s(e,()=>t.children,null),e})()}function Y(t){return n(l.Description,m({"data-slot":"toast-description"},t))}function j(t){return(()=>{var e=x();return k(e,t,!1,!1),e})()}function E(t){const e=R();return n(l.CloseButton,m({"data-slot":"toast-close-button",as:$,icon:"close",variant:"ghost",get"aria-label"(){return e.t("ui.common.dismiss")}},t))}function N(t){return n(l.ProgressTrack,m({"data-slot":"toast-progress-track"},t))}function z(t){return n(l.ProgressFill,m({"data-slot":"toast-progress-fill"},t))}const o=Object.assign(O,{Region:L,Icon:U,TitleRow:V,Content:D,Title:F,Description:Y,Actions:j,CloseButton:E,ProgressTrack:N,ProgressFill:z}),K={error:"warning",success:"check-small"};function h(t){const e=typeof t=="string"?{description:t}:t;return f.show(r=>n(o,{get toastId(){return r.toastId},get duration(){return e.duration},get persistent(){return e.persistent},get"data-variant"(){return e.variant??"default"},get children(){return[n(g,{get when(){return e.icon},get children(){return n(o.Icon,{get name(){return e.icon}})}}),n(o.Content,{get children(){return[n(g,{get when(){return e.title},get children(){return n(o.TitleRow,{get icon(){return K[e.variant??"default"]},get children(){return n(o.Title,{get children(){return e.title}})}})}}),n(g,{get when(){return e.description},get children(){return n(o.Description,{get children(){return e.description}})}}),n(g,{get when(){return e.actions?.length},get children(){return n(o.Actions,{get children(){return e.actions.map(w=>(()=>{var y=A();return y.$$click=()=>{typeof w.onClick=="function"&&w.onClick(),f.dismiss(r.toastId)},s(y,()=>w.label),y})())}})}})]}}),n(o.CloseButton,{})]}}))}function q(t,e){return f.promise(t,r=>n(o,{get toastId(){return r.toastId},get"data-variant"(){return u(()=>r.state==="pending")()?"loading":r.state==="fulfilled"?"success":"error"},get children(){return[n(o.Content,{get children(){return n(o.Description,{get children(){return[u(()=>u(()=>r.state==="pending")()&&e.loading),u(()=>u(()=>r.state==="fulfilled")()&&e.success?.(r.data)),u(()=>u(()=>r.state==="rejected")()&&e.error?.(r.error))]}})}}),n(o.CloseButton,{})]}}))}S(["click"]);var T=p("<div style=display:grid;gap:12px>");const G=`### Overview
Toast notifications with optional icons, actions, and progress.

Use brief titles/descriptions; limit actions to 1-2.

### API
- Use \`showToast\` or \`showPromiseToast\` to trigger toasts.
- Render \`Toast.Region\` once per page.
- \`Toast\` subcomponents compose the structure.

### Variants and states
- Variants: default, success, error, loading.
- Optional actions and persistent toasts.

### Behavior
- Toasts render in a portal and auto-dismiss unless persistent.

### Accessibility
- TODO: confirm aria-live behavior from Kobalte Toast.

### Theming/tokens
- Uses \`data-component="toast"\` and slot data attributes.

`,et={title:"UI/Toast",id:"components-toast",component:o,tags:["autodocs"],parameters:{docs:{description:{component:G}}}},i={render:()=>(()=>{var t=T();return s(t,n(o.Region,{}),null),s(t,n(v,{variant:"primary",onClick:()=>h({title:"Saved",description:"Your changes are stored.",variant:"success",icon:"check"}),children:"Show success toast"}),null),s(t,n(v,{variant:"secondary",onClick:()=>h({description:"This action needs attention.",variant:"error",icon:"warning"}),children:"Show error toast"}),null),t})()},c={render:()=>(()=>{var t=T();return s(t,n(o.Region,{}),null),s(t,n(v,{variant:"secondary",onClick:()=>h({title:"Update available",description:"Restart to apply the update.",actions:[{label:"Restart",onClick:"dismiss"},{label:"Later",onClick:"dismiss"}]}),children:"Show action toast"}),null),t})()},a={render:()=>(()=>{var t=T();return s(t,n(o.Region,{}),null),s(t,n(v,{variant:"secondary",onClick:()=>q(()=>new a(e=>setTimeout(()=>e(!0),800)),{loading:"Saving...",success:()=>"Saved",error:()=>"Failed"}),children:"Show promise toast"}),null),t})()},d={render:()=>(()=>{var t=T();return s(t,n(o.Region,{}),null),s(t,n(v,{variant:"secondary",onClick:()=>h({description:"Syncing...",variant:"loading",persistent:!0}),children:"Show loading toast"}),null),t})()};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Basic = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Toast.Region />
    <Button
      variant="primary"
      onClick={() =>
        mod.showToast({
          title: "Saved",
          description: "Your changes are stored.",
          variant: "success",
          icon: "check",
        })
      }
    >
      Show success toast
    </Button>
    <Button
      variant="secondary"
      onClick={() =>
        mod.showToast({
          description: "This action needs attention.",
          variant: "error",
          icon: "warning",
        })
      }
    >
      Show error toast
    </Button>
  </div>
);
`,...i.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Actions = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Toast.Region />
    <Button
      variant="secondary"
      onClick={() =>
        mod.showToast({
          title: "Update available",
          description: "Restart to apply the update.",
          actions: [
            { label: "Restart", onClick: "dismiss" },
            { label: "Later", onClick: "dismiss" },
          ],
        })
      }
    >
      Show action toast
    </Button>
  </div>
);
`,...c.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Promise = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Toast.Region />
    <Button
      variant="secondary"
      onClick={() =>
        mod.showPromiseToast(
          () => new Promise((resolve) => setTimeout(() => resolve(true), 800)),
          {
            loading: "Saving...",
            success: () => "Saved",
            error: () => "Failed",
          },
        )
      }
    >
      Show promise toast
    </Button>
  </div>
);
`,...a.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Loading = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.Toast.Region />
    <Button
      variant="secondary"
      onClick={() =>
        mod.showToast({
          description: "Syncing...",
          variant: "loading",
          persistent: true,
        })
      }
    >
      Show loading toast
    </Button>
  </div>
);
`,...d.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Toast.Region />
      <Button variant="primary" onClick={() => mod.showToast({
      title: "Saved",
      description: "Your changes are stored.",
      variant: "success",
      icon: "check"
    })}>
        Show success toast
      </Button>
      <Button variant="secondary" onClick={() => mod.showToast({
      description: "This action needs attention.",
      variant: "error",
      icon: "warning"
    })}>
        Show error toast
      </Button>
    </div>
}`,...i.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Toast.Region />
      <Button variant="secondary" onClick={() => mod.showToast({
      title: "Update available",
      description: "Restart to apply the update.",
      actions: [{
        label: "Restart",
        onClick: "dismiss"
      }, {
        label: "Later",
        onClick: "dismiss"
      }]
    })}>
        Show action toast
      </Button>
    </div>
}`,...c.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Toast.Region />
      <Button variant="secondary" onClick={() => mod.showPromiseToast(() => new Promise(resolve => setTimeout(() => resolve(true), 800)), {
      loading: "Saving...",
      success: () => "Saved",
      error: () => "Failed"
    })}>
        Show promise toast
      </Button>
    </div>
}`,...a.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.Toast.Region />
      <Button variant="secondary" onClick={() => mod.showToast({
      description: "Syncing...",
      variant: "loading",
      persistent: true
    })}>
        Show loading toast
      </Button>
    </div>
}`,...d.parameters?.docs?.source}}};const ot=["Basic","Actions","Promise","Loading"];export{c as Actions,i as Basic,d as Loading,a as Promise,ot as __namedExportsOrder,et as default};
