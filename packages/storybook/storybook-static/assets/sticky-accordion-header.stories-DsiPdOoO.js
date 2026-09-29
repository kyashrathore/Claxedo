import{b as e,t as n}from"./iframe-D288tw9h.js";import{A as o}from"./accordion-V7tDW2yd.js";import{S as c}from"./sticky-accordion-header-DWXG9Fz6.js";import"./preload-helper-D9Z9MdNV.js";import"./OVO32WR3-uXBHbXmd.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./LP6E37CW-BgXoIsgV.js";import"./UGE6PPGT-C6B63Gso.js";import"./SOM3K36D-DFQE1dRQ.js";var t=n('<div style="color:var(--text-weak);padding:8px 0">Accordion content.');const i=`### Overview
Sticky accordion header wrapper for persistent section labels.

Use only inside \`Accordion.Item\` with \`Accordion.Trigger\`.

### API
- Accepts standard header props and children.

### Variants and states
- Inherits accordion states.

### Behavior
- Renders inside an Accordion item header.

### Accessibility
- TODO: confirm semantics from Accordion.Header usage.

### Theming/tokens
- Uses \`data-component="sticky-accordion-header"\`.

`,v={title:"UI/StickyAccordionHeader",id:"components-sticky-accordion-header",component:c,tags:["autodocs"],parameters:{docs:{description:{component:i}}}},r={render:()=>e(o,{value:"first",get children(){return e(o.Item,{value:"first",get children(){return[e(c,{get children(){return e(o.Trigger,{children:"Sticky header"})}}),e(o.Content,{get children(){return t()}})]}})}})};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Basic = () => (
  <Accordion value="first">
    <Accordion.Item value="first">
      <mod.StickyAccordionHeader>
        <Accordion.Trigger>Sticky header</Accordion.Trigger>
      </mod.StickyAccordionHeader>
      <Accordion.Content>
        <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
          Accordion content.
        </div>
      </Accordion.Content>
    </Accordion.Item>
  </Accordion>
);
`,...r.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <Accordion value="first">
      <Accordion.Item value="first">
        <mod.StickyAccordionHeader>
          <Accordion.Trigger>Sticky header</Accordion.Trigger>
        </mod.StickyAccordionHeader>
        <Accordion.Content>
          <div style={{
          color: "var(--text-weak)",
          padding: "8px 0"
        }}>Accordion content.</div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion>
}`,...r.parameters?.docs?.source}}};const y=["Basic"];export{r as Basic,y as __namedExportsOrder,v as default};
