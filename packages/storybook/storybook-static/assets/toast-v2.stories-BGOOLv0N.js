import{b as n,m as d,I as w,t as o,a1 as m,O as f,i as a,S as h}from"./iframe-D288tw9h.js";import{T as l,t as u}from"./6TDKM7BK-viiLtHP4.js";import{B as c}from"./button-v2-DbG8OeJh.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var A=o("<div data-slot=toast-v2-icon>"),y=o("<div data-slot=toast-v2-content>"),C=o("<div data-slot=toast-v2-actions>"),x=o('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M4.25 11.75L11.75 4.25"stroke=currentColor></path><path d="M11.75 11.75L4.25 4.25"stroke=currentColor>'),k=o("<div data-slot=toast-v2-header>");function V(t){return n(m,{get children(){return n(l.Region,d({"data-component":"toast-v2-region"},t,{get children(){return n(l.List,{"data-slot":"toast-v2-list"})}}))}})}function B(t){return n(l,d({"data-component":"toast-v2",get classList(){return{"ui-toast-v2":!0,...t.classList,[t.class??""]:!!t.class}}},t))}function T(t){return(()=>{var e=A();return w(e,t,!1,!1),e})()}function b(t){return(()=>{var e=y();return w(e,t,!1,!1),e})()}function M(t){return n(l.Title,d({"data-slot":"toast-v2-title"},t))}function S(t){return n(l.Description,d({"data-slot":"toast-v2-description"},t))}function L(t){return(()=>{var e=C();return w(e,t,!1,!1),e})()}function $(t){return n(l.CloseButton,d({"data-slot":"toast-v2-close-button","aria-label":"Dismiss"},t,{get children(){return x()}}))}const s=Object.assign(B,{Region:V,Icon:T,Content:b,Title:M,Description:S,Actions:L,CloseButton:$});function g(t){const e=typeof t=="string"?{description:t}:t;return u.show(v=>{const p=f(()=>e.icon);return n(s,{get toastId(){return v.toastId},get duration(){return e.duration},get persistent(){return e.persistent},get children(){return[(()=>{var i=k();return a(i,n(h,{get when(){return p()},get children(){return n(s.Icon,{get children(){return p()}})}}),null),a(i,n(s.Content,{get children(){return[n(h,{get when(){return e.title},get children(){return n(s.Title,{get children(){return e.title}})}}),n(h,{get when(){return e.description},get children(){return n(s.Description,{get children(){return e.description}})}})]}}),null),a(i,n(s.CloseButton,{}),null),i})(),n(h,{get when(){return e.actions?.length},get children(){return n(s.Actions,{get children(){return e.actions.map(i=>n(c,{get variant(){return i.variant==="secondary"?"ghost":"neutral"},size:"small",get"data-action-variant"(){return i.variant??"primary"},onClick:()=>{typeof i.onClick=="function"&&i.onClick(),u.dismiss(v.toastId)},get children(){return i.label}}))}})}})]}})})}var _=o("<div style=display:grid;gap:12px>"),H=o('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><path d="M13.5554 10.4453V13.5564H11.7777H4.22211C3.23989 13.5564 2.44434 13.5564 2.44434 13.5564V10.4453"stroke=var(--icon-icon-base)></path><path d="M4.88867 6L7.99978 9.11111L11.1109 6"stroke=var(--icon-icon-base)></path><path d="M8 9.11198V2.44531"stroke=var(--icon-icon-base)>'),R=o('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><path d="M8.00011 14.4436C11.5593 14.4436 14.4446 11.5583 14.4446 7.99913C14.4446 4.43996 11.5593 1.55469 8.00011 1.55469C4.44094 1.55469 1.55566 4.43996 1.55566 7.99913C1.55566 11.5583 4.44094 14.4436 8.00011 14.4436Z"stroke=#198B43></path><path d="M5.11133 8.22135L7.11133 10.4436L10.8891 5.55469"stroke=#198B43>'),I=o('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><rect x=8.75 y=5.25 width=2 height=2 fill=#3A3A3A></rect><rect x=8.75 y=8.75 width=2 height=2 fill=#3A3A3A></rect><rect x=8.75 y=12.25 width=2 height=2 fill=#3A3A3A></rect><rect x=5.25 y=12.25 width=2 height=2 fill=#3A3A3A></rect><rect opacity=0.3 x=5.25 y=1.75 width=2 height=2 fill=#3A3A3A></rect><rect opacity=0.3 x=5.25 y=5.25 width=2 height=2 fill=#3A3A3A></rect><rect opacity=0.3 x=5.25 y=8.75 width=2 height=2 fill=#3A3A3A></rect><rect opacity=0.3 x=8.75 y=1.75 width=2 height=2 fill=#3A3A3A>'),D=o('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><path d="M8 6.33334V8.99392M7.78099 10.9934H8.23448M8 2L1.5 13H14.5L8 2Z"stroke=#CB9F34 stroke-linecap=square>');const O=`### Overview
Toast notifications with optional icons, actions, and progress.

Use brief titles/descriptions; limit actions to 1-2.

### API
- Use \`showToastV2\` or \`showPromiseToastV2\` to trigger toasts.
- Render \`ToastV2.Region\` once per page.
- \`ToastV2\` subcomponents compose the structure.

### Styling and states
- Single toast style; provide any custom icon element via \`icon\`.
- Optional actions and persistent toasts.

### Behavior
- Toasts render in a portal and auto-dismiss unless persistent.

### Accessibility
- TODO: confirm aria-live behavior from Kobalte Toast.

### Theming/tokens
- Uses \`data-component="toast-v2"\` and slot data attributes.

`,j={title:"UI V2/Toast",id:"components-toast-v2",component:s,tags:["autodocs"],parameters:{frameHeight:"320px",frameBackground:"#fff",docs:{description:{component:O}}}},r={render:()=>(()=>{var t=_();return a(t,n(s.Region,{}),null),a(t,n(c,{class:"w-fit",variant:"neutral",onClick:()=>g({title:"Download started...",description:"23% · 2 min left",icon:H(),actions:[{label:"Run in background",variant:"primary",onClick:"dismiss"},{label:"Cancel",variant:"secondary",onClick:"dismiss"}]}),children:"Show download toast"}),null),a(t,n(c,{class:"w-fit",variant:"neutral",onClick:()=>g({title:"Saved",description:"Your changes are stored",icon:R()}),children:"Show saved toast"}),null),a(t,n(c,{class:"w-fit",variant:"neutral",onClick:()=>g({title:"Saving...",icon:I(),persistent:!0}),children:"Show saving toast"}),null),a(t,n(c,{class:"w-fit",variant:"neutral",onClick:()=>g({title:"Unsaved changes",description:"You have made 4 edits...",icon:D(),actions:[{label:"Save changes",variant:"primary",onClick:"dismiss"},{label:"Cancel",variant:"secondary",onClick:"dismiss"}]}),children:"Show unsaved changes toast"}),null),t})()};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const AllExamples = () => (
  <div style={{ display: "grid", gap: "12px" }}>
    <mod.ToastV2.Region />
    <ButtonV2
      class="w-fit"
      variant="neutral"
      onClick={() =>
        mod.showToastV2({
          title: "Download started...",
          description: "23% · 2 min left",
          icon: (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M13.5554 10.4453V13.5564H11.7777H4.22211C3.23989 13.5564 2.44434 13.5564 2.44434 13.5564V10.4453"
                stroke="var(--icon-icon-base)"
              />
              <path
                d="M4.88867 6L7.99978 9.11111L11.1109 6"
                stroke="var(--icon-icon-base)"
              />
              <path d="M8 9.11198V2.44531" stroke="var(--icon-icon-base)" />
            </svg>
          ),
          actions: [
            {
              label: "Run in background",
              variant: "primary",
              onClick: "dismiss",
            },
            { label: "Cancel", variant: "secondary", onClick: "dismiss" },
          ],
        })
      }
    >
      Show download toast
    </ButtonV2>
    <ButtonV2
      class="w-fit"
      variant="neutral"
      onClick={() =>
        mod.showToastV2({
          title: "Saved",
          description: "Your changes are stored",
          icon: (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M8.00011 14.4436C11.5593 14.4436 14.4446 11.5583 14.4446 7.99913C14.4446 4.43996 11.5593 1.55469 8.00011 1.55469C4.44094 1.55469 1.55566 4.43996 1.55566 7.99913C1.55566 11.5583 4.44094 14.4436 8.00011 14.4436Z"
                stroke="#198B43"
              />
              <path
                d="M5.11133 8.22135L7.11133 10.4436L10.8891 5.55469"
                stroke="#198B43"
              />
            </svg>
          ),
        })
      }
    >
      Show saved toast
    </ButtonV2>
    <ButtonV2
      class="w-fit"
      variant="neutral"
      onClick={() =>
        mod.showToastV2({
          title: "Saving...",
          icon: (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="8.75" y="5.25" width="2" height="2" fill="#3A3A3A" />
              <rect x="8.75" y="8.75" width="2" height="2" fill="#3A3A3A" />
              <rect x="8.75" y="12.25" width="2" height="2" fill="#3A3A3A" />
              <rect x="5.25" y="12.25" width="2" height="2" fill="#3A3A3A" />
              <rect
                opacity="0.3"
                x="5.25"
                y="1.75"
                width="2"
                height="2"
                fill="#3A3A3A"
              />
              <rect
                opacity="0.3"
                x="5.25"
                y="5.25"
                width="2"
                height="2"
                fill="#3A3A3A"
              />
              <rect
                opacity="0.3"
                x="5.25"
                y="8.75"
                width="2"
                height="2"
                fill="#3A3A3A"
              />
              <rect
                opacity="0.3"
                x="8.75"
                y="1.75"
                width="2"
                height="2"
                fill="#3A3A3A"
              />
            </svg>
          ),
          persistent: true,
        })
      }
    >
      Show saving toast
    </ButtonV2>
    <ButtonV2
      class="w-fit"
      variant="neutral"
      onClick={() =>
        mod.showToastV2({
          title: "Unsaved changes",
          description: "You have made 4 edits...",
          icon: (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M8 6.33334V8.99392M7.78099 10.9934H8.23448M8 2L1.5 13H14.5L8 2Z"
                stroke="#CB9F34"
                stroke-linecap="square"
              />
            </svg>
          ),
          actions: [
            { label: "Save changes", variant: "primary", onClick: "dismiss" },
            { label: "Cancel", variant: "secondary", onClick: "dismiss" },
          ],
        })
      }
    >
      Show unsaved changes toast
    </ButtonV2>
  </div>
);
`,...r.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "grid",
    gap: "12px"
  }}>
      <mod.ToastV2.Region />
      <ButtonV2 class="w-fit" variant="neutral" onClick={() => mod.showToastV2({
      title: "Download started...",
      description: "23% · 2 min left",
      icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13.5554 10.4453V13.5564H11.7777H4.22211C3.23989 13.5564 2.44434 13.5564 2.44434 13.5564V10.4453" stroke="var(--icon-icon-base)" />
                <path d="M4.88867 6L7.99978 9.11111L11.1109 6" stroke="var(--icon-icon-base)" />
                <path d="M8 9.11198V2.44531" stroke="var(--icon-icon-base)" />
              </svg>,
      actions: [{
        label: "Run in background",
        variant: "primary",
        onClick: "dismiss"
      }, {
        label: "Cancel",
        variant: "secondary",
        onClick: "dismiss"
      }]
    })}>
        Show download toast
      </ButtonV2>
      <ButtonV2 class="w-fit" variant="neutral" onClick={() => mod.showToastV2({
      title: "Saved",
      description: "Your changes are stored",
      icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8.00011 14.4436C11.5593 14.4436 14.4446 11.5583 14.4446 7.99913C14.4446 4.43996 11.5593 1.55469 8.00011 1.55469C4.44094 1.55469 1.55566 4.43996 1.55566 7.99913C1.55566 11.5583 4.44094 14.4436 8.00011 14.4436Z" stroke="#198B43" />
                <path d="M5.11133 8.22135L7.11133 10.4436L10.8891 5.55469" stroke="#198B43" />
              </svg>
    })}>
        Show saved toast
      </ButtonV2>
      <ButtonV2 class="w-fit" variant="neutral" onClick={() => mod.showToastV2({
      title: "Saving...",
      icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="8.75" y="5.25" width="2" height="2" fill="#3A3A3A" />
                <rect x="8.75" y="8.75" width="2" height="2" fill="#3A3A3A" />
                <rect x="8.75" y="12.25" width="2" height="2" fill="#3A3A3A" />
                <rect x="5.25" y="12.25" width="2" height="2" fill="#3A3A3A" />
                <rect opacity="0.3" x="5.25" y="1.75" width="2" height="2" fill="#3A3A3A" />
                <rect opacity="0.3" x="5.25" y="5.25" width="2" height="2" fill="#3A3A3A" />
                <rect opacity="0.3" x="5.25" y="8.75" width="2" height="2" fill="#3A3A3A" />
                <rect opacity="0.3" x="8.75" y="1.75" width="2" height="2" fill="#3A3A3A" />
              </svg>,
      persistent: true
    })}>
        Show saving toast
      </ButtonV2>
      <ButtonV2 class="w-fit" variant="neutral" onClick={() => mod.showToastV2({
      title: "Unsaved changes",
      description: "You have made 4 edits...",
      icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 6.33334V8.99392M7.78099 10.9934H8.23448M8 2L1.5 13H14.5L8 2Z" stroke="#CB9F34" stroke-linecap="square" />
              </svg>,
      actions: [{
        label: "Save changes",
        variant: "primary",
        onClick: "dismiss"
      }, {
        label: "Cancel",
        variant: "secondary",
        onClick: "dismiss"
      }]
    })}>
        Show unsaved changes toast
      </ButtonV2>
    </div>
}`,...r.parameters?.docs?.source}}};const z=["AllExamples"];export{r as AllExamples,z as __namedExportsOrder,j as default};
