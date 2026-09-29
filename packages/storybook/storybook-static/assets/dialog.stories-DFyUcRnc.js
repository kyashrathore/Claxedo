import{i as g,b as t,Y as D,K as k,t as y,S as f,T as z,U as C,x as L,L as v,u as h,o as O}from"./iframe-D288tw9h.js";import{u as x}from"./i18n-CW9P7x91.js";import{I as T}from"./icon-button-C_HG_auw.js";import{B as d}from"./button-Bsz0PTzb.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var S=y("<div data-slot=dialog-header>"),N=y("<div data-slot=dialog-body class=ui-dialog-body>"),A=y("<div data-component=dialog><div data-slot=dialog-container class=ui-dialog-container>");function c(n){const e=x();return(()=>{var u=A(),b=u.firstChild;return g(b,t(D.Content,{"data-slot":"dialog-content",get"aria-label"(){return L(()=>!!n.title)()?void 0:n["aria-label"]},get"data-no-header"(){return!n.title&&!n.action?"":void 0},get classList(){return{"ui-dialog-content":!0,...n.classList,[n.class??""]:!!n.class}},onOpenAutoFocus:o=>{const m=o.currentTarget;if(!(m instanceof Element))return;const p=m.querySelector("[autofocus]");p instanceof HTMLElement&&(o.preventDefault(),p.focus())},get onEscapeKeyDown(){return n.onEscapeKeyDown},get children(){return[t(f,{get when(){return n.title||n.action},get children(){var o=S();return g(o,t(f,{get when(){return n.title},get children(){return t(D.Title,{"data-slot":"dialog-title",get children(){return n.title}})}}),null),g(o,t(z,{get children(){return[t(C,{get when(){return n.action},get children(){return n.action}}),t(C,{when:!0,get children(){return t(D.CloseButton,{"data-slot":"dialog-close-button",as:T,icon:"close",variant:"ghost",get"aria-label"(){return e.t("ui.common.close")}})}})]}}),null),o}}),t(f,{get when(){return n.description},get children(){return t(D.Description,{"data-slot":"dialog-description",get children(){return n.description}})}}),(()=>{var o=N();return g(o,()=>n.children),o})()]}})),k(o=>{var m=n.fit?!0:void 0,p=n.flush?!0:void 0,B=n.size||"normal",w=n.transition?!0:void 0;return m!==o.e&&v(u,"data-fit",o.e=m),p!==o.t&&v(u,"data-flush",o.t=p),B!==o.a&&v(u,"data-size",o.a=B),w!==o.o&&v(u,"data-transition",o.o=w),o},{e:void 0,t:void 0,a:void 0,o:void 0}),u})()}var E=y("<div style=display:flex;gap:12px>");const X=`### Overview
Dialog content wrapper used with the DialogProvider for modal flows.

Provide concise title/description and keep body focused.

### API
- Optional: \`title\`, \`description\`, \`action\`.
- \`size\`: normal | large | x-large.
- \`fit\` and \`transition\` control layout and animation.

### Variants and states
- Sizes and optional header/action controls.

### Behavior
- Intended to be rendered via \`useDialog().show\`.

### Accessibility
- TODO: confirm focus trapping and aria attributes from Kobalte Dialog.

### Theming/tokens
- Uses \`data-component="dialog"\` and slot attributes.

`,U={title:"UI/Dialog",id:"components-dialog",component:c,tags:["autodocs"],parameters:{docs:{description:{component:X}}}},a={render:()=>{const n=h(),e=()=>n.show(()=>t(c,{title:"Dialog",description:"Description",children:"Dialog body content."}));return O(e),t(d,{variant:"secondary",onClick:e,children:"Open dialog"})}},i={render:()=>{const n=h();return(()=>{var e=E();return g(e,t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{title:"Normal",description:"Normal size",children:"Normal dialog content."})),children:"Normal"}),null),g(e,t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{size:"large",title:"Large",description:"Large size",children:"Large dialog content."})),children:"Large"}),null),g(e,t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{size:"x-large",title:"Extra large",description:"X-large size",children:"X-large dialog content."})),children:"X-Large"}),null),e})()}},r={render:()=>{const n=h();return t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{title:"Transition",description:"Animated",transition:!0,children:"Transition enabled."})),children:"Open transition dialog"})}},s={render:()=>{const n=h();return t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{title:"Custom action",description:"Dialog with a custom header action",get action(){return t(d,{variant:"ghost",children:"Help"})},children:"Dialog body content."})),children:"Open action dialog"})}},l={render:()=>{const n=h();return t(d,{variant:"secondary",onClick:()=>n.show(()=>t(c,{title:"Fit content",fit:!0,children:"Dialog fits its content."})),children:"Open fit dialog"})}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Basic = () => {
  const dialog = useDialog();
  const open = () =>
    dialog.show(() => (
      <mod.Dialog title="Dialog" description="Description">
        Dialog body content.
      </mod.Dialog>
    ));

  onMount(open);

  return (
    <Button variant="secondary" onClick={open}>
      Open dialog
    </Button>
  );
};
`,...a.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Sizes = () => {
  const dialog = useDialog();
  return (
    <div style={{ display: "flex", gap: "12px" }}>
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.Dialog title="Normal" description="Normal size">
              Normal dialog content.
            </mod.Dialog>
          ))
        }
      >
        Normal
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.Dialog size="large" title="Large" description="Large size">
              Large dialog content.
            </mod.Dialog>
          ))
        }
      >
        Large
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.Dialog
              size="x-large"
              title="Extra large"
              description="X-large size"
            >
              X-large dialog content.
            </mod.Dialog>
          ))
        }
      >
        X-Large
      </Button>
    </div>
  );
};
`,...i.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Transition = () => {
  const dialog = useDialog();
  return (
    <Button
      variant="secondary"
      onClick={() =>
        dialog.show(() => (
          <mod.Dialog title="Transition" description="Animated" transition>
            Transition enabled.
          </mod.Dialog>
        ))
      }
    >
      Open transition dialog
    </Button>
  );
};
`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const CustomAction = () => {
  const dialog = useDialog();
  return (
    <Button
      variant="secondary"
      onClick={() =>
        dialog.show(() => (
          <mod.Dialog
            title="Custom action"
            description="Dialog with a custom header action"
            action={<Button variant="ghost">Help</Button>}
          >
            Dialog body content.
          </mod.Dialog>
        ))
      }
    >
      Open action dialog
    </Button>
  );
};
`,...s.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const Fit = () => {
  const dialog = useDialog();
  return (
    <Button
      variant="secondary"
      onClick={() =>
        dialog.show(() => (
          <mod.Dialog title="Fit content" fit>
            Dialog fits its content.
          </mod.Dialog>
        ))
      }
    >
      Open fit dialog
    </Button>
  );
};
`,...l.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    const open = () => dialog.show(() => <mod.Dialog title="Dialog" description="Description">
          Dialog body content.
        </mod.Dialog>);
    onMount(open);
    return <Button variant="secondary" onClick={open}>
        Open dialog
      </Button>;
  }
}`,...a.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    return <div style={{
      display: "flex",
      gap: "12px"
    }}>
        <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog title="Normal" description="Normal size">
                Normal dialog content.
              </mod.Dialog>)}>
          Normal
        </Button>
        <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog size="large" title="Large" description="Large size">
                Large dialog content.
              </mod.Dialog>)}>
          Large
        </Button>
        <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog size="x-large" title="Extra large" description="X-large size">
                X-large dialog content.
              </mod.Dialog>)}>
          X-Large
        </Button>
      </div>;
  }
}`,...i.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    return <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog title="Transition" description="Animated" transition>
              Transition enabled.
            </mod.Dialog>)}>
        Open transition dialog
      </Button>;
  }
}`,...r.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    return <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog title="Custom action" description="Dialog with a custom header action" action={<Button variant="ghost">Help</Button>}>
              Dialog body content.
            </mod.Dialog>)}>
        Open action dialog
      </Button>;
  }
}`,...s.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    return <Button variant="secondary" onClick={() => dialog.show(() => <mod.Dialog title="Fit content" fit>
              Dialog fits its content.
            </mod.Dialog>)}>
        Open fit dialog
      </Button>;
  }
}`,...l.parameters?.docs?.source}}};const q=["Basic","Sizes","Transition","CustomAction","Fit"];export{a as Basic,s as CustomAction,l as Fit,i as Sizes,r as Transition,q as __namedExportsOrder,U as default};
