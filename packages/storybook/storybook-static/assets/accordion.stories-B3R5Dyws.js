import{c as g,a as v,i as A,b as e,t as i}from"./iframe-D288tw9h.js";import{I as m}from"./icon-BG5j3Qjr.js";import{m as b,A as o}from"./accordion-V7tDW2yd.js";import{c as h}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./OVO32WR3-uXBHbXmd.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./LP6E37CW-BgXoIsgV.js";import"./UGE6PPGT-C6B63Gso.js";import"./SOM3K36D-DFQE1dRQ.js";var a=i('<div style="color:var(--text-weak);padding:8px 0">Accordion content.'),p=i('<div style="color:var(--text-weak);padding:8px 0">More content.'),f=i("<div style=display:grid;gap:8px;width:420px>");const C='### Overview\nAccordion for collapsible content sections with optional multi-open behavior.\n\nUse one trigger per item; keep content concise.\n\n### API\n- Root supports Kobalte Accordion props: `value`, `multiple`, `collapsible`, `onChange`.\n- Compose with `Accordion.Item`, `Header`, `Trigger`, `Content`.\n\n### Variants and states\n- Single or multiple open items.\n- Collapsible or fixed-open behavior.\n\n### Behavior\n- Controlled via `value`/`onChange` when provided.\n\n### Accessibility\n- TODO: confirm keyboard navigation from Kobalte Accordion.\n\n### Theming/tokens\n- Uses `data-component="accordion"` and slot data attributes.\n\n',I=h({title:"UI/Accordion",mod:b}),E={title:"UI/Accordion",id:"components-accordion",component:I.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:C}}}},r={args:{collapsible:!0,multiple:!1,value:"first"},argTypes:{collapsible:{control:"boolean"},multiple:{control:"boolean"},value:{control:"select",options:["first","second","none"],mapping:{none:void 0}}},render:n=>{const[d,l]=g(n.value);v(()=>{l(n.value)});const u=()=>Array.isArray(d())?d():d()?[d()]:[];return(()=>{var s=f();return A(s,e(o,{get collapsible(){return n.collapsible},get multiple(){return n.multiple},get value(){return u()},onChange:l,get children(){return[e(o.Item,{value:"first",get children(){return[e(o.Header,{get children(){return e(o.Trigger,{get children(){return["First ",e(m,{name:"chevron-down",size:"small","data-slot":"accordion-caret"})]}})}}),e(o.Content,{get children(){return a()}})]}}),e(o.Item,{value:"second",get children(){return[e(o.Header,{get children(){return e(o.Trigger,{get children(){return["Second ",e(m,{name:"chevron-down",size:"small","data-slot":"accordion-caret"})]}})}}),e(o.Content,{get children(){return p()}})]}})]}})),s})()}},c={args:{collapsible:!0,multiple:!0,value:["first","second"]},render:n=>e(o,{get collapsible(){return n.collapsible},get multiple(){return n.multiple},get value(){return n.value},get children(){return[e(o.Item,{value:"first",get children(){return[e(o.Header,{get children(){return e(o.Trigger,{children:"First"})}}),e(o.Content,{get children(){return a()}})]}}),e(o.Item,{value:"second",get children(){return[e(o.Header,{get children(){return e(o.Trigger,{children:"Second"})}}),e(o.Content,{get children(){return p()}})]}})]}})},t={args:{collapsible:!1,multiple:!1,value:"first"},render:n=>e(o,{get collapsible(){return n.collapsible},get multiple(){return n.multiple},get value(){return n.value},get children(){return e(o.Item,{value:"first",get children(){return[e(o.Header,{get children(){return e(o.Trigger,{children:"First"})}}),e(o.Content,{get children(){return a()}})]}})}})};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Basic = (props) => {
  const [value, setValue] = createSignal(props.value);
  createEffect(() => {
    setValue(props.value);
  });

  // Kobalte uses an array of selected item values even in single-open mode.
  const current = () =>
    Array.isArray(value()) ? value() : value() ? [value()] : [];

  return (
    <div style={{ display: "grid", gap: "8px", width: "420px" }}>
      <mod.Accordion
        collapsible={props.collapsible}
        multiple={props.multiple}
        value={current()}
        onChange={setValue}
      >
        <mod.Accordion.Item value="first">
          <mod.Accordion.Header>
            <mod.Accordion.Trigger>
              First{" "}
              <Icon
                name="chevron-down"
                size="small"
                data-slot="accordion-caret"
              />
            </mod.Accordion.Trigger>
          </mod.Accordion.Header>
          <mod.Accordion.Content>
            <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
              Accordion content.
            </div>
          </mod.Accordion.Content>
        </mod.Accordion.Item>
        <mod.Accordion.Item value="second">
          <mod.Accordion.Header>
            <mod.Accordion.Trigger>
              Second{" "}
              <Icon
                name="chevron-down"
                size="small"
                data-slot="accordion-caret"
              />
            </mod.Accordion.Trigger>
          </mod.Accordion.Header>
          <mod.Accordion.Content>
            <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
              More content.
            </div>
          </mod.Accordion.Content>
        </mod.Accordion.Item>
      </mod.Accordion>
    </div>
  );
};
`,...r.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Multiple = (props) => (
  <mod.Accordion
    collapsible={props.collapsible}
    multiple={props.multiple}
    value={props.value}
  >
    <mod.Accordion.Item value="first">
      <mod.Accordion.Header>
        <mod.Accordion.Trigger>First</mod.Accordion.Trigger>
      </mod.Accordion.Header>
      <mod.Accordion.Content>
        <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
          Accordion content.
        </div>
      </mod.Accordion.Content>
    </mod.Accordion.Item>
    <mod.Accordion.Item value="second">
      <mod.Accordion.Header>
        <mod.Accordion.Trigger>Second</mod.Accordion.Trigger>
      </mod.Accordion.Header>
      <mod.Accordion.Content>
        <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
          More content.
        </div>
      </mod.Accordion.Content>
    </mod.Accordion.Item>
  </mod.Accordion>
);
`,...c.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const NonCollapsible = (props) => (
  <mod.Accordion
    collapsible={props.collapsible}
    multiple={props.multiple}
    value={props.value}
  >
    <mod.Accordion.Item value="first">
      <mod.Accordion.Header>
        <mod.Accordion.Trigger>First</mod.Accordion.Trigger>
      </mod.Accordion.Header>
      <mod.Accordion.Content>
        <div style={{ color: "var(--text-weak)", padding: "8px 0" }}>
          Accordion content.
        </div>
      </mod.Accordion.Content>
    </mod.Accordion.Item>
  </mod.Accordion>
);
`,...t.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  args: {
    collapsible: true,
    multiple: false,
    value: "first"
  },
  argTypes: {
    collapsible: {
      control: "boolean"
    },
    multiple: {
      control: "boolean"
    },
    value: {
      control: "select",
      options: ["first", "second", "none"],
      mapping: {
        none: undefined
      }
    }
  },
  render: props => {
    const [value, setValue] = createSignal(props.value);
    createEffect(() => {
      setValue(props.value);
    });

    // Kobalte uses an array of selected item values even in single-open mode.
    const current = () => Array.isArray(value()) ? value() : value() ? [value()] : [];
    return <div style={{
      display: "grid",
      gap: "8px",
      width: "420px"
    }}>
        <mod.Accordion collapsible={props.collapsible} multiple={props.multiple} value={current()} onChange={setValue}>
          <mod.Accordion.Item value="first">
            <mod.Accordion.Header>
              <mod.Accordion.Trigger>
                First <Icon name="chevron-down" size="small" data-slot="accordion-caret" />
              </mod.Accordion.Trigger>
            </mod.Accordion.Header>
            <mod.Accordion.Content>
              <div style={{
              color: "var(--text-weak)",
              padding: "8px 0"
            }}>Accordion content.</div>
            </mod.Accordion.Content>
          </mod.Accordion.Item>
          <mod.Accordion.Item value="second">
            <mod.Accordion.Header>
              <mod.Accordion.Trigger>
                Second <Icon name="chevron-down" size="small" data-slot="accordion-caret" />
              </mod.Accordion.Trigger>
            </mod.Accordion.Header>
            <mod.Accordion.Content>
              <div style={{
              color: "var(--text-weak)",
              padding: "8px 0"
            }}>More content.</div>
            </mod.Accordion.Content>
          </mod.Accordion.Item>
        </mod.Accordion>
      </div>;
  }
}`,...r.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  args: {
    collapsible: true,
    multiple: true,
    value: ["first", "second"]
  },
  render: props => <mod.Accordion collapsible={props.collapsible} multiple={props.multiple} value={props.value}>
      <mod.Accordion.Item value="first">
        <mod.Accordion.Header>
          <mod.Accordion.Trigger>First</mod.Accordion.Trigger>
        </mod.Accordion.Header>
        <mod.Accordion.Content>
          <div style={{
          color: "var(--text-weak)",
          padding: "8px 0"
        }}>Accordion content.</div>
        </mod.Accordion.Content>
      </mod.Accordion.Item>
      <mod.Accordion.Item value="second">
        <mod.Accordion.Header>
          <mod.Accordion.Trigger>Second</mod.Accordion.Trigger>
        </mod.Accordion.Header>
        <mod.Accordion.Content>
          <div style={{
          color: "var(--text-weak)",
          padding: "8px 0"
        }}>More content.</div>
        </mod.Accordion.Content>
      </mod.Accordion.Item>
    </mod.Accordion>
}`,...c.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    collapsible: false,
    multiple: false,
    value: "first"
  },
  render: props => <mod.Accordion collapsible={props.collapsible} multiple={props.multiple} value={props.value}>
      <mod.Accordion.Item value="first">
        <mod.Accordion.Header>
          <mod.Accordion.Trigger>First</mod.Accordion.Trigger>
        </mod.Accordion.Header>
        <mod.Accordion.Content>
          <div style={{
          color: "var(--text-weak)",
          padding: "8px 0"
        }}>Accordion content.</div>
        </mod.Accordion.Content>
      </mod.Accordion.Item>
    </mod.Accordion>
}`,...t.parameters?.docs?.source}}};const K=["Basic","Multiple","NonCollapsible"];export{r as Basic,c as Multiple,t as NonCollapsible,K as __namedExportsOrder,E as default};
