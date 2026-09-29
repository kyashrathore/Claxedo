import{s as f,i as g,b as a,Y as e,K as P,t as K,L as O,W as F,ac as S,x as h,O as C,S as x}from"./iframe-D288tw9h.js";import{B as l}from"./button-v2-DbG8OeJh.js";import"./preload-helper-D9Z9MdNV.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var $=K("<div data-slot=dialog-footer>"),_=K("<div data-slot=dialog-body>"),N=K("<div data-slot=dialog-title-group>"),W=K("<div data-slot=dialog-header>"),X=K('<svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M12.4446 3.55469L3.55566 12.4436M3.55566 3.55469L12.4446 12.4436"stroke=currentColor stroke-linejoin=round>'),E=K("<div data-component=dialog-v2><div data-slot=dialog-container>");function L(t){return(()=>{var o=$();return g(o,()=>t.children),o})()}function m(t){const[o]=f(t,["class","children"]);return(()=>{var n=_();return g(n,()=>o.children),P(()=>S(n,`${o.class||""} ui-dialog-body`)),n})()}function Y(t){return a(e.Title,{"data-slot":"dialog-header-title",get children(){return t.children}})}function z(t){const o=C(()=>t.title),n=C(()=>t.description);return(()=>{var i=N();return g(i,a(x,{get when(){return o()},children:r=>a(e.Title,{"data-slot":"dialog-title",get children(){return r()}})}),null),g(i,a(e.Description,{"data-slot":"dialog-description",get children(){return n()}}),null),i})()}function V(t){const[o]=f(t,["closeLabel","hideClose","children"]),n=()=>o.hideClose===!0;return(()=>{var i=W();return g(i,()=>o.children,null),g(i,(()=>{var r=h(()=>!n());return()=>r()&&a(e.CloseButton,{"data-slot":"dialog-close-button",get"aria-label"(){return o.closeLabel??"Close"},get children(){return X()}})})(),null),P(()=>O(i,"data-hide-close",n()?"":void 0)),i})()}function s(t){const[o]=f(t,["size","variant","class","containerClass","classList","fit","children"]);return(()=>{var n=E(),i=n.firstChild;return g(i,a(e.Content,{"data-slot":"dialog-content",get classList(){return{"ui-dialog-content":!0,...o.classList,[o.class??""]:!!o.class}},onOpenAutoFocus:r=>{const B=r.currentTarget;if(!(B instanceof Element))return;const T=B.querySelector("[autofocus]");T instanceof HTMLElement&&(r.preventDefault(),T.focus({preventScroll:!0}))},get children(){return o.children}})),P(r=>{var B=o.variant==="settings"?"settings":void 0,T=o.fit?!0:void 0,H=o.size||"normal",w={"ui-dialog-container":!0,[o.containerClass??""]:!!o.containerClass};return B!==r.e&&O(n,"data-variant",r.e=B),T!==r.t&&O(n,"data-fit",r.t=T),H!==r.a&&O(n,"data-size",r.a=H),r.o=F(i,w,r.o),r},{e:void 0,t:void 0,a:void 0,o:void 0}),n})()}var k=K("<div style=display:flex;gap:12px>"),G=K("<span style=margin-right:auto>");const U='### Overview\nDialog content wrapper built on Kobalte\'s dialog primitive with v2 styling.\n\nCompose with `DialogHeader`, `DialogTitle`, `DialogTitleGroup`, `DialogBody`, and `DialogFooter`.\n\n### API\n- `Dialog`: `size` (normal | large | x-large), `variant`, `fit`.\n- `DialogHeader`: row container with optional `closeLabel` and `hideClose`.\n- `DialogTitle`: accessible single-line header title.\n- `DialogTitleGroup`: column with `title` and required `description`.\n\n### Accessibility\n- Focus trapping and aria attributes provided by Kobalte Dialog.\n\n### Theming/tokens\n- Uses `data-component="dialog-v2"` and slot attributes.\n',J={title:"UI V2/Dialog",id:"components-dialog-v2",component:s,tags:["autodocs"],parameters:{docs:{description:{component:U}}}};function y(t,o){return a(V,{get children(){return a(z,{title:t,description:o})}})}const d={render:()=>a(e,{defaultOpen:!0,get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{get children(){return[h(()=>y("Dialog","Description")),a(m,{children:"Dialog body content."})]}})]}})]}})},c={render:()=>(()=>{var t=k();return g(t,a(e,{get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Normal"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{get children(){return[h(()=>y("Normal","Normal size")),a(m,{children:"Normal dialog content."})]}})]}})]}}),null),g(t,a(e,{get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Large"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{size:"large",get children(){return[h(()=>y("Large","Large size")),a(m,{children:"Large dialog content."})]}})]}})]}}),null),g(t,a(e,{get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"X-Large"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{size:"x-large",get children(){return[h(()=>y("Extra large","X-large size")),a(m,{children:"X-large dialog content."})]}})]}})]}}),null),t})()},u={render:()=>a(e,{defaultOpen:!0,get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{get children(){return[a(V,{get children(){return a(Y,{children:"Open project"})}}),a(m,{children:"Dialog body content."})]}})]}})]}})},D={render:()=>a(e,{get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{get children(){return[a(V,{get children(){return[a(z,{title:"Custom header",description:"Dialog with an extra header control"}),a(l,{variant:"neutral",size:"small",children:"Help"})]}}),a(m,{children:"Dialog body content."})]}})]}})]}})},p={render:()=>a(e,{defaultOpen:!0,get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{fit:!0,get children(){return[h(()=>y("Save changes","Your changes will be lost if you don't save them.")),a(L,{get children(){return[a(l,{variant:"neutral",children:"Cancel"}),a(l,{variant:"contrast",children:"Save"})]}})]}})]}})]}})},b={render:()=>a(e,{defaultOpen:!0,get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{fit:!0,get children(){return[h(()=>y("Unsaved changes","You have unsaved changes. What would you like to do?")),a(L,{get children(){return[(()=>{var t=G();return g(t,a(l,{variant:"ghost",children:"Remind me later"})),t})(),a(l,{variant:"neutral",children:"Cancel"}),a(l,{variant:"contrast",children:"Save"})]}})]}})]}})]}})},v={render:()=>a(e,{get children(){return[a(e.Trigger,{as:l,variant:"neutral",children:"Open fit dialog"}),a(e.Portal,{get children(){return[a(e.Overlay,{}),a(s,{fit:!0,get children(){return[h(()=>y("Fit content","Dialog fits its content.")),a(m,{children:"Dialog fits its content."})]}})]}})]}})};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Basic = () => (
  <KobalteDialog defaultOpen>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog>
        {dialogHeader("Dialog", "Description")}
        <DialogBody>Dialog body content.</DialogBody>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Sizes = () => (
  <div style={{ display: "flex", gap: "12px" }}>
    <KobalteDialog>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Normal
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          {dialogHeader("Normal", "Normal size")}
          <DialogBody>Normal dialog content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>

    <KobalteDialog>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Large
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog size="large">
          {dialogHeader("Large", "Large size")}
          <DialogBody>Large dialog content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>

    <KobalteDialog>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        X-Large
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog size="x-large">
          {dialogHeader("Extra large", "X-large size")}
          <DialogBody>X-large dialog content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  </div>
);
`,...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const TitleOnly = () => (
  <KobalteDialog defaultOpen>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog>
        <DialogHeader>
          <DialogTitle>Open project</DialogTitle>
        </DialogHeader>
        <DialogBody>Dialog body content.</DialogBody>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...u.parameters?.docs?.source}}};D.parameters={...D.parameters,docs:{...D.parameters?.docs,source:{code:`const HeaderControls = () => (
  <KobalteDialog>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog>
        <DialogHeader>
          <DialogTitleGroup
            title="Custom header"
            description="Dialog with an extra header control"
          />
          <ButtonV2 variant="neutral" size="small">
            Help
          </ButtonV2>
        </DialogHeader>
        <DialogBody>Dialog body content.</DialogBody>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...D.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const WithFooter = () => (
  <KobalteDialog defaultOpen>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog fit>
        {dialogHeader(
          "Save changes",
          "Your changes will be lost if you don't save them.",
        )}
        <DialogFooter>
          <ButtonV2 variant="neutral">Cancel</ButtonV2>
          <ButtonV2 variant="contrast">Save</ButtonV2>
        </DialogFooter>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...p.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{code:`const WithFooterThreeButtons = () => (
  <KobalteDialog defaultOpen>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog fit>
        {dialogHeader(
          "Unsaved changes",
          "You have unsaved changes. What would you like to do?",
        )}
        <DialogFooter>
          <span style={{ "margin-right": "auto" }}>
            <ButtonV2 variant="ghost">Remind me later</ButtonV2>
          </span>
          <ButtonV2 variant="neutral">Cancel</ButtonV2>
          <ButtonV2 variant="contrast">Save</ButtonV2>
        </DialogFooter>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...b.parameters?.docs?.source}}};v.parameters={...v.parameters,docs:{...v.parameters?.docs,source:{code:`const Fit = () => (
  <KobalteDialog>
    <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
      Open fit dialog
    </KobalteDialog.Trigger>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay />
      <Dialog fit>
        {dialogHeader("Fit content", "Dialog fits its content.")}
        <DialogBody>Dialog fits its content.</DialogBody>
      </Dialog>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
`,...v.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          {dialogHeader("Dialog", "Description")}
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...d.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    display: "flex",
    gap: "12px"
  }}>
      <KobalteDialog>
        <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
          Normal
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog>
            {dialogHeader("Normal", "Normal size")}
            <DialogBody>Normal dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>

      <KobalteDialog>
        <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
          Large
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog size="large">
            {dialogHeader("Large", "Large size")}
            <DialogBody>Large dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>

      <KobalteDialog>
        <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
          X-Large
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog size="x-large">
            {dialogHeader("Extra large", "X-large size")}
            <DialogBody>X-large dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>
    </div>
}`,...c.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          <DialogHeader>
            <DialogTitle>Open project</DialogTitle>
          </DialogHeader>
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...u.parameters?.docs?.source}}};D.parameters={...D.parameters,docs:{...D.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          <DialogHeader>
            <DialogTitleGroup title="Custom header" description="Dialog with an extra header control" />
            <ButtonV2 variant="neutral" size="small">
              Help
            </ButtonV2>
          </DialogHeader>
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...D.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Save changes", "Your changes will be lost if you don't save them.")}
          <DialogFooter>
            <ButtonV2 variant="neutral">Cancel</ButtonV2>
            <ButtonV2 variant="contrast">Save</ButtonV2>
          </DialogFooter>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...p.parameters?.docs?.source}}};b.parameters={...b.parameters,docs:{...b.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Unsaved changes", "You have unsaved changes. What would you like to do?")}
          <DialogFooter>
            <span style={{
            "margin-right": "auto"
          }}>
              <ButtonV2 variant="ghost">Remind me later</ButtonV2>
            </span>
            <ButtonV2 variant="neutral">Cancel</ButtonV2>
            <ButtonV2 variant="contrast">Save</ButtonV2>
          </DialogFooter>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...b.parameters?.docs?.source}}};v.parameters={...v.parameters,docs:{...v.parameters?.docs,source:{originalSource:`{
  render: () => <KobalteDialog>
      <KobalteDialog.Trigger as={ButtonV2} variant="neutral">
        Open fit dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Fit content", "Dialog fits its content.")}
          <DialogBody>Dialog fits its content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
}`,...v.parameters?.docs?.source}}};const Q=["Basic","Sizes","TitleOnly","HeaderControls","WithFooter","WithFooterThreeButtons","Fit"];export{d as Basic,v as Fit,D as HeaderControls,c as Sizes,u as TitleOnly,p as WithFooter,b as WithFooterThreeButtons,Q as __namedExportsOrder,J as default};
