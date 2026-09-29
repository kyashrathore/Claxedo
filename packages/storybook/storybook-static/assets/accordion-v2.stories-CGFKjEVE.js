import{s as V,b as e,m,i as g,S as b,t as A,K as u,ab as h}from"./iframe-D288tw9h.js";import{A as p}from"./OVO32WR3-uXBHbXmd.js";import"./preload-helper-D9Z9MdNV.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./LP6E37CW-BgXoIsgV.js";import"./UGE6PPGT-C6B63Gso.js";import"./SOM3K36D-DFQE1dRQ.js";var I=A('<svg data-slot=accordion-v2-chevron class=ui-accordion-v2-chevron width=14 height=14 viewBox="0 0 14 14"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><path d="M4 5.5L7 8.5L10 5.5"stroke=currentColor>'),T=A("<span data-slot=accordion-v2-trigger-content>"),H=A("<div data-slot=accordion-v2-content-inner>");const y=()=>I();function f(n){const[o,c]=V(n,["class","classList"]);return e(p,m(c,{"data-component":"accordion-v2",get classList(){return{...o.classList,[o.class??""]:!!o.class}}}))}function w(n){const[o,c]=V(n,["class","classList"]);return e(p.Item,m(c,{"data-component":"accordion-v2-item",get classList(){return{"ui-accordion-v2-item":!0,...o.classList,[o.class??""]:!!o.class}}}))}function S(n){const[o,c]=V(n,["class","classList","children"]);return e(p.Header,m(c,{"data-slot":"accordion-v2-header",get classList(){return{...o.classList,[o.class??""]:!!o.class}},get children(){return o.children}}))}function x(n){const[o,c]=V(n,["class","classList","children","hideChevron"]);return e(p.Trigger,m(c,{"data-component":"accordion-v2-trigger",get classList(){return{"ui-accordion-v2-trigger":!0,...o.classList,[o.class??""]:!!o.class}},get children(){return[(()=>{var l=T();return g(l,()=>o.children),l})(),e(b,{get when(){return!o.hideChevron},get children(){return e(y,{})}})]}}))}function L(n){const[o,c]=V(n,["class","classList","children"]);return e(p.Content,m(c,{"data-component":"accordion-v2-content",get classList(){return{"ui-accordion-v2-content":!0,...o.classList,[o.class??""]:!!o.class}},get children(){var l=H();return g(l,()=>o.children),l}}))}const r=Object.assign(f,{Item:w,Header:S,Trigger:x,Content:L});var v=A("<div>"),_=A("<div style=display:grid;gap:8px><p style=margin:0>Accordions are useful for compressing dense content into scannable sections. They preserve heading semantics and announce open/closed state to screen readers.</p><p style=margin:0>The body can hold arbitrary content — paragraphs, lists, even nested components.</p><ul style=margin:0;padding-left:16px><li>Keyboard navigable</li><li>Animated</li><li>Themeable via CSS variables"),$=A("<code>hideChevron");const B="### Overview\nCompound accordion built on Kobalte's `Accordion` primitive. The trigger automatically renders a chevron that rotates open.\n\n### API\n- `AccordionV2` — root; forwards Kobalte props (`multiple`, `collapsible`, `value`, `defaultValue`, `onChange`, etc.).\n- `AccordionV2.Item` — one expandable row; requires a unique `value: string`.\n- `AccordionV2.Header` — wraps the trigger; preserves heading semantics.\n- `AccordionV2.Trigger` — auto-renders a trailing chevron; pass `hideChevron` to opt out.\n- `AccordionV2.Content` — body shown when the item is expanded; height-animated.\n\n### Behavior\n- Single-select by default (`collapsible` allows closing the active item). Use `multiple` to let several items open at once.\n- Open/closed state is reflected on items, triggers, and content via `data-expanded` / `data-closed`.\n- Content height animates using Kobalte's `--kb-collapsible-content-height` variable.\n",E={title:"UI V2/Accordion",id:"components-accordion-v2",component:r,tags:["autodocs"],parameters:{frameBackground:"#f5f5f5",docs:{description:{component:B}}}},C={width:"346px","font-family":"var(--v2-font-family-sans)","font-size":"13px"},t={render:()=>(()=>{var n=v();return g(n,e(r,{collapsible:!0,defaultValue:["item-1"],get children(){return[e(r.Item,{value:"item-1",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Is it accessible?"})}}),e(r.Content,{children:"Yes. It follows the WAI-ARIA Accordion pattern and ships with full keyboard support."})]}}),e(r.Item,{value:"item-2",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Is it styled?"})}}),e(r.Content,{children:"Yeah"})]}}),e(r.Item,{value:"item-3",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Is it animated?"})}}),e(r.Content,{children:"Yes. Height animates via Kobalte's collapsible height variable."})]}})]}})),u(o=>h(n,C,o)),n})()},i={render:()=>(()=>{var n=v();return g(n,e(r,{multiple:!0,defaultValue:["a","c"],get children(){return[e(r.Item,{value:"a",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Section A"})}}),e(r.Content,{children:"Multiple items can be open at once."})]}}),e(r.Item,{value:"b",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Section B"})}}),e(r.Content,{children:"Open me too."})]}}),e(r.Item,{value:"c",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Section C"})}}),e(r.Content,{children:"Already open by default."})]}})]}})),u(o=>h(n,C,o)),n})()},d={render:()=>(()=>{var n=v();return g(n,e(r,{collapsible:!0,get children(){return[e(r.Item,{value:"one",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Enabled item"})}}),e(r.Content,{children:"Body content."})]}}),e(r.Item,{value:"two",disabled:!0,get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Disabled item"})}}),e(r.Content,{children:"You can't open this one."})]}}),e(r.Item,{value:"three",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Another enabled item"})}}),e(r.Content,{children:"Body content."})]}})]}})),u(o=>h(n,C,o)),n})()},a={render:()=>(()=>{var n=v();return g(n,e(r,{collapsible:!0,defaultValue:["long"],get children(){return[e(r.Item,{value:"long",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"What's inside?"})}}),e(r.Content,{get children(){var o=_(),c=o.firstChild,l=c.nextSibling;return l.nextSibling,o}})]}}),e(r.Item,{value:"short",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"One more"})}}),e(r.Content,{children:"Short body."})]}})]}})),u(o=>h(n,C,o)),n})()},s={render:()=>(()=>{var n=v();return g(n,e(r,{collapsible:!0,get children(){return[e(r.Item,{value:"x",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{hideChevron:!0,children:"Trigger without chevron"})}}),e(r.Content,{get children(){return["Pass ",$()," on the trigger."]}})]}}),e(r.Item,{value:"y",get children(){return[e(r.Header,{get children(){return e(r.Trigger,{children:"Default trigger"})}}),e(r.Content,{children:"Chevron renders by default."})]}})]}})),u(o=>h(n,C,o)),n})()};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Basic = () => (
  <div style={frame}>
    <AccordionV2 collapsible defaultValue={["item-1"]}>
      <AccordionV2.Item value="item-1">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Is it accessible?</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>
          Yes. It follows the WAI-ARIA Accordion pattern and ships with full
          keyboard support.
        </AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="item-2">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Is it styled?</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Yeah</AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="item-3">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Is it animated?</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>
          Yes. Height animates via Kobalte's collapsible height variable.
        </AccordionV2.Content>
      </AccordionV2.Item>
    </AccordionV2>
  </div>
);
`,...t.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Multiple = () => (
  <div style={frame}>
    <AccordionV2 multiple defaultValue={["a", "c"]}>
      <AccordionV2.Item value="a">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Section A</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>
          Multiple items can be open at once.
        </AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="b">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Section B</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Open me too.</AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="c">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Section C</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Already open by default.</AccordionV2.Content>
      </AccordionV2.Item>
    </AccordionV2>
  </div>
);
`,...i.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Disabled = () => (
  <div style={frame}>
    <AccordionV2 collapsible>
      <AccordionV2.Item value="one">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Enabled item</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Body content.</AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="two" disabled>
        <AccordionV2.Header>
          <AccordionV2.Trigger>Disabled item</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>You can't open this one.</AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="three">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Another enabled item</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Body content.</AccordionV2.Content>
      </AccordionV2.Item>
    </AccordionV2>
  </div>
);
`,...d.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const LongContent = () => (
  <div style={frame}>
    <AccordionV2 collapsible defaultValue={["long"]}>
      <AccordionV2.Item value="long">
        <AccordionV2.Header>
          <AccordionV2.Trigger>What's inside?</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>
          <div style={{ display: "grid", gap: "8px" }}>
            <p style={{ margin: 0 }}>
              Accordions are useful for compressing dense content into scannable
              sections. They preserve heading semantics and announce open/closed
              state to screen readers.
            </p>
            <p style={{ margin: 0 }}>
              The body can hold arbitrary content — paragraphs, lists, even
              nested components.
            </p>
            <ul style={{ margin: 0, "padding-left": "16px" }}>
              <li>Keyboard navigable</li>
              <li>Animated</li>
              <li>Themeable via CSS variables</li>
            </ul>
          </div>
        </AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="short">
        <AccordionV2.Header>
          <AccordionV2.Trigger>One more</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Short body.</AccordionV2.Content>
      </AccordionV2.Item>
    </AccordionV2>
  </div>
);
`,...a.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const NoChevron = () => (
  <div style={frame}>
    <AccordionV2 collapsible>
      <AccordionV2.Item value="x">
        <AccordionV2.Header>
          <AccordionV2.Trigger hideChevron>
            Trigger without chevron
          </AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>
          Pass <code>hideChevron</code> on the trigger.
        </AccordionV2.Content>
      </AccordionV2.Item>
      <AccordionV2.Item value="y">
        <AccordionV2.Header>
          <AccordionV2.Trigger>Default trigger</AccordionV2.Trigger>
        </AccordionV2.Header>
        <AccordionV2.Content>Chevron renders by default.</AccordionV2.Content>
      </AccordionV2.Item>
    </AccordionV2>
  </div>
);
`,...s.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  render: () => <div style={frame}>
      <AccordionV2 collapsible defaultValue={["item-1"]}>
        <AccordionV2.Item value="item-1">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Is it accessible?</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>
            Yes. It follows the WAI-ARIA Accordion pattern and ships with full keyboard support.
          </AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="item-2">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Is it styled?</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Yeah</AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="item-3">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Is it animated?</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Yes. Height animates via Kobalte's collapsible height variable.</AccordionV2.Content>
        </AccordionV2.Item>
      </AccordionV2>
    </div>
}`,...t.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <div style={frame}>
      <AccordionV2 multiple defaultValue={["a", "c"]}>
        <AccordionV2.Item value="a">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Section A</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Multiple items can be open at once.</AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="b">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Section B</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Open me too.</AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="c">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Section C</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Already open by default.</AccordionV2.Content>
        </AccordionV2.Item>
      </AccordionV2>
    </div>
}`,...i.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => <div style={frame}>
      <AccordionV2 collapsible>
        <AccordionV2.Item value="one">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Enabled item</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Body content.</AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="two" disabled>
          <AccordionV2.Header>
            <AccordionV2.Trigger>Disabled item</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>You can't open this one.</AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="three">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Another enabled item</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Body content.</AccordionV2.Content>
        </AccordionV2.Item>
      </AccordionV2>
    </div>
}`,...d.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <div style={frame}>
      <AccordionV2 collapsible defaultValue={["long"]}>
        <AccordionV2.Item value="long">
          <AccordionV2.Header>
            <AccordionV2.Trigger>What's inside?</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>
            <div style={{
            display: "grid",
            gap: "8px"
          }}>
              <p style={{
              margin: 0
            }}>
                Accordions are useful for compressing dense content into scannable sections. They preserve heading
                semantics and announce open/closed state to screen readers.
              </p>
              <p style={{
              margin: 0
            }}>
                The body can hold arbitrary content — paragraphs, lists, even nested components.
              </p>
              <ul style={{
              margin: 0,
              "padding-left": "16px"
            }}>
                <li>Keyboard navigable</li>
                <li>Animated</li>
                <li>Themeable via CSS variables</li>
              </ul>
            </div>
          </AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="short">
          <AccordionV2.Header>
            <AccordionV2.Trigger>One more</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Short body.</AccordionV2.Content>
        </AccordionV2.Item>
      </AccordionV2>
    </div>
}`,...a.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <div style={frame}>
      <AccordionV2 collapsible>
        <AccordionV2.Item value="x">
          <AccordionV2.Header>
            <AccordionV2.Trigger hideChevron>Trigger without chevron</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>
            Pass <code>hideChevron</code> on the trigger.
          </AccordionV2.Content>
        </AccordionV2.Item>
        <AccordionV2.Item value="y">
          <AccordionV2.Header>
            <AccordionV2.Trigger>Default trigger</AccordionV2.Trigger>
          </AccordionV2.Header>
          <AccordionV2.Content>Chevron renders by default.</AccordionV2.Content>
        </AccordionV2.Item>
      </AccordionV2>
    </div>
}`,...s.parameters?.docs?.source}}};const R=["Basic","Multiple","Disabled","LongContent","NoChevron"];export{t as Basic,d as Disabled,a as LongContent,i as Multiple,s as NoChevron,R as __namedExportsOrder,E as default};
