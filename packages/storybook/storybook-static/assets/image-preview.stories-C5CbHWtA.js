import{u as a,o as i,b as n}from"./iframe-D288tw9h.js";import{I as t}from"./image-preview-CVWCbdq8.js";import{B as c}from"./button-Bsz0PTzb.js";import"./preload-helper-D9Z9MdNV.js";import"./i18n-CW9P7x91.js";import"./icon-button-C_HG_auw.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";const p=`### Overview
Image preview content intended to render inside the dialog stack.

Use for full-size image inspection; keep images optimized.

### API
- Required: \`src\`.
- Optional: \`alt\` text.

### Variants and states
- Single layout with close action.

### Behavior
- Intended to be used via \`useDialog().show\`.

### Accessibility
- Uses localized aria-label for close button.

### Theming/tokens
- Uses \`data-component="image-preview"\` and slot attributes.

`,I={title:"UI/ImagePreview",id:"components-image-preview",component:t,tags:["autodocs"],parameters:{docs:{description:{component:p}}}},e={render:()=>{const s=a(),r="https://placehold.co/640x360/png",o=()=>s.show(()=>n(t,{src:r,alt:"Preview"}));return i(o),n(c,{variant:"secondary",onClick:o,children:"Open image preview"})}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => {
  const dialog = useDialog();
  const src = "https://placehold.co/640x360/png";

  const open = () =>
    dialog.show(() => <mod.ImagePreview src={src} alt="Preview" />);

  onMount(open);

  return (
    <Button variant="secondary" onClick={open}>
      Open image preview
    </Button>
  );
};
`,...e.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => {
    const dialog = useDialog();
    const src = "https://placehold.co/640x360/png";
    const open = () => dialog.show(() => <mod.ImagePreview src={src} alt="Preview" />);
    onMount(open);
    return <Button variant="secondary" onClick={open}>
        Open image preview
      </Button>;
  }
}`,...e.parameters?.docs?.source}}};const P=["Basic"];export{e as Basic,P as __namedExportsOrder,I as default};
