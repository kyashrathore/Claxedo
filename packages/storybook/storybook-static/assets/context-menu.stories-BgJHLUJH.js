import{b as t,m as a,s as c,t as i}from"./iframe-D288tw9h.js";import{C as s}from"./UMC5UGBH-VRUJmC09.js";import"./preload-helper-D9Z9MdNV.js";import"./T4C3DMHT-DBumxLXp.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./SOM3K36D-DFQE1dRQ.js";import"./VI7QYH27-BdSgIyCK.js";function m(n){return t(s,a(n,{"data-component":"context-menu"}))}function x(n){const[e,o]=c(n,["class","classList","children"]);return t(s.Trigger,a(o,{"data-slot":"context-menu-trigger",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function C(n){const[e,o]=c(n,["class","classList","children"]);return t(s.Icon,a(o,{"data-slot":"context-menu-icon",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function p(n){return t(s.Portal,n)}function M(n){const[e,o]=c(n,["class","classList","children"]);return t(s.Content,a(o,{"data-component":"context-menu-content",get classList(){return{"ui-context-menu-content":!0,...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function g(n){const[e,o]=c(n,["class","classList"]);return t(s.Arrow,a(o,{"data-slot":"context-menu-arrow",get classList(){return{...e.classList,[e.class??""]:!!e.class}}}))}function b(n){const[e,o]=c(n,["class","classList"]);return t(s.Separator,a(o,{"data-slot":"context-menu-separator",get classList(){return{...e.classList,[e.class??""]:!!e.class}}}))}function h(n){const[e,o]=c(n,["class","classList","children"]);return t(s.Group,a(o,{"data-slot":"context-menu-group",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function I(n){const[e,o]=c(n,["class","classList","children"]);return t(s.GroupLabel,a(o,{"data-slot":"context-menu-group-label",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function L(n){const[e,o]=c(n,["class","classList","children"]);return t(s.Item,a(o,{"data-slot":"context-menu-item",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function f(n){const[e,o]=c(n,["class","classList","children"]);return t(s.ItemLabel,a(o,{"data-slot":"context-menu-item-label",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function S(n){const[e,o]=c(n,["class","classList","children"]);return t(s.ItemDescription,a(o,{"data-slot":"context-menu-item-description",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function k(n){const[e,o]=c(n,["class","classList","children"]);return t(s.ItemIndicator,a(o,{"data-slot":"context-menu-item-indicator",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function v(n){const[e,o]=c(n,["class","classList","children"]);return t(s.RadioGroup,a(o,{"data-slot":"context-menu-radio-group",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function R(n){const[e,o]=c(n,["class","classList","children"]);return t(s.RadioItem,a(o,{"data-slot":"context-menu-radio-item",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function G(n){const[e,o]=c(n,["class","classList","children"]);return t(s.CheckboxItem,a(o,{"data-slot":"context-menu-checkbox-item",get classList(){return{...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function T(n){return t(s.Sub,n)}function w(n){const[e,o]=c(n,["class","classList","children"]);return t(s.SubTrigger,a(o,{"data-slot":"context-menu-sub-trigger",get classList(){return{"ui-context-menu-sub-trigger":!0,...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}function P(n){const[e,o]=c(n,["class","classList","children"]);return t(s.SubContent,a(o,{"data-component":"context-menu-sub-content",get classList(){return{"ui-context-menu-sub-content":!0,...e.classList,[e.class??""]:!!e.class}},get children(){return e.children}}))}const r=Object.assign(m,{Trigger:x,Icon:C,Portal:p,Content:M,Arrow:g,Separator:b,Group:h,GroupLabel:I,Item:L,ItemLabel:f,ItemDescription:S,ItemIndicator:k,RadioGroup:v,RadioItem:R,CheckboxItem:G,Sub:T,SubTrigger:w,SubContent:P});var d=i('<div style="padding:20px;border:1px dashed var(--border-weak);border-radius:8px;color:var(--text-weak)">Right click (or open) here');const O='### Overview\nContext menu for right-click interactions with composable items and submenus.\n\nUse `ItemLabel` and `ItemDescription` for rich items.\n\n### API\n- Root accepts Kobalte ContextMenu props (`open`, `defaultOpen`, `onOpenChange`).\n- Compose `Trigger`, `Content`, `Item`, `Separator`, and optional `Sub` sections.\n\n### Variants and states\n- Supports grouped sections and nested submenus.\n\n### Behavior\n- Opens on context menu gesture over the trigger element.\n\n### Accessibility\n- TODO: confirm keyboard and focus behavior from Kobalte.\n\n### Theming/tokens\n- Uses `data-component="context-menu"` and slot attributes for styling.\n\n',E={title:"UI/ContextMenu",id:"components-context-menu",component:r,tags:["autodocs"],parameters:{docs:{description:{component:O}}}},u={render:()=>t(r,{defaultOpen:!0,get children(){return[t(r.Trigger,{get children(){return d()}}),t(r.Portal,{get children(){return t(r.Content,{get children(){return[t(r.Group,{get children(){return[t(r.GroupLabel,{children:"Actions"}),t(r.Item,{get children(){return t(r.ItemLabel,{children:"Copy"})}}),t(r.Item,{get children(){return t(r.ItemLabel,{children:"Paste"})}})]}}),t(r.Separator,{}),t(r.Sub,{get children(){return[t(r.SubTrigger,{children:"More"}),t(r.SubContent,{get children(){return[t(r.Item,{get children(){return t(r.ItemLabel,{children:"Duplicate"})}}),t(r.Item,{get children(){return t(r.ItemLabel,{children:"Move"})}})]}})]}})]}})}})]}})},l={render:()=>t(r,{defaultOpen:!0,get children(){return[t(r.Trigger,{get children(){return d()}}),t(r.Portal,{get children(){return t(r.Content,{get children(){return[t(r.CheckboxItem,{checked:!0,children:"Show line numbers"}),t(r.CheckboxItem,{children:"Wrap lines"}),t(r.Separator,{}),t(r.RadioGroup,{value:"compact",get children(){return[t(r.RadioItem,{value:"compact",children:"Compact"}),t(r.RadioItem,{value:"comfortable",children:"Comfortable"})]}})]}})}})]}})};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const Basic = () => (
  <mod.ContextMenu defaultOpen>
    <mod.ContextMenu.Trigger>
      <div
        style={{
          padding: "20px",
          border: "1px dashed var(--border-weak)",
          "border-radius": "8px",
          color: "var(--text-weak)",
        }}
      >
        Right click (or open) here
      </div>
    </mod.ContextMenu.Trigger>
    <mod.ContextMenu.Portal>
      <mod.ContextMenu.Content>
        <mod.ContextMenu.Group>
          <mod.ContextMenu.GroupLabel>Actions</mod.ContextMenu.GroupLabel>
          <mod.ContextMenu.Item>
            <mod.ContextMenu.ItemLabel>Copy</mod.ContextMenu.ItemLabel>
          </mod.ContextMenu.Item>
          <mod.ContextMenu.Item>
            <mod.ContextMenu.ItemLabel>Paste</mod.ContextMenu.ItemLabel>
          </mod.ContextMenu.Item>
        </mod.ContextMenu.Group>
        <mod.ContextMenu.Separator />
        <mod.ContextMenu.Sub>
          <mod.ContextMenu.SubTrigger>More</mod.ContextMenu.SubTrigger>
          <mod.ContextMenu.SubContent>
            <mod.ContextMenu.Item>
              <mod.ContextMenu.ItemLabel>Duplicate</mod.ContextMenu.ItemLabel>
            </mod.ContextMenu.Item>
            <mod.ContextMenu.Item>
              <mod.ContextMenu.ItemLabel>Move</mod.ContextMenu.ItemLabel>
            </mod.ContextMenu.Item>
          </mod.ContextMenu.SubContent>
        </mod.ContextMenu.Sub>
      </mod.ContextMenu.Content>
    </mod.ContextMenu.Portal>
  </mod.ContextMenu>
);
`,...u.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const CheckboxRadio = () => (
  <mod.ContextMenu defaultOpen>
    <mod.ContextMenu.Trigger>
      <div
        style={{
          padding: "20px",
          border: "1px dashed var(--border-weak)",
          "border-radius": "8px",
          color: "var(--text-weak)",
        }}
      >
        Right click (or open) here
      </div>
    </mod.ContextMenu.Trigger>
    <mod.ContextMenu.Portal>
      <mod.ContextMenu.Content>
        <mod.ContextMenu.CheckboxItem checked>
          Show line numbers
        </mod.ContextMenu.CheckboxItem>
        <mod.ContextMenu.CheckboxItem>Wrap lines</mod.ContextMenu.CheckboxItem>
        <mod.ContextMenu.Separator />
        <mod.ContextMenu.RadioGroup value="compact">
          <mod.ContextMenu.RadioItem value="compact">
            Compact
          </mod.ContextMenu.RadioItem>
          <mod.ContextMenu.RadioItem value="comfortable">
            Comfortable
          </mod.ContextMenu.RadioItem>
        </mod.ContextMenu.RadioGroup>
      </mod.ContextMenu.Content>
    </mod.ContextMenu.Portal>
  </mod.ContextMenu>
);
`,...l.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => <mod.ContextMenu defaultOpen>
      <mod.ContextMenu.Trigger>
        <div style={{
        padding: "20px",
        border: "1px dashed var(--border-weak)",
        "border-radius": "8px",
        color: "var(--text-weak)"
      }}>
          Right click (or open) here
        </div>
      </mod.ContextMenu.Trigger>
      <mod.ContextMenu.Portal>
        <mod.ContextMenu.Content>
          <mod.ContextMenu.Group>
            <mod.ContextMenu.GroupLabel>Actions</mod.ContextMenu.GroupLabel>
            <mod.ContextMenu.Item>
              <mod.ContextMenu.ItemLabel>Copy</mod.ContextMenu.ItemLabel>
            </mod.ContextMenu.Item>
            <mod.ContextMenu.Item>
              <mod.ContextMenu.ItemLabel>Paste</mod.ContextMenu.ItemLabel>
            </mod.ContextMenu.Item>
          </mod.ContextMenu.Group>
          <mod.ContextMenu.Separator />
          <mod.ContextMenu.Sub>
            <mod.ContextMenu.SubTrigger>More</mod.ContextMenu.SubTrigger>
            <mod.ContextMenu.SubContent>
              <mod.ContextMenu.Item>
                <mod.ContextMenu.ItemLabel>Duplicate</mod.ContextMenu.ItemLabel>
              </mod.ContextMenu.Item>
              <mod.ContextMenu.Item>
                <mod.ContextMenu.ItemLabel>Move</mod.ContextMenu.ItemLabel>
              </mod.ContextMenu.Item>
            </mod.ContextMenu.SubContent>
          </mod.ContextMenu.Sub>
        </mod.ContextMenu.Content>
      </mod.ContextMenu.Portal>
    </mod.ContextMenu>
}`,...u.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => <mod.ContextMenu defaultOpen>
      <mod.ContextMenu.Trigger>
        <div style={{
        padding: "20px",
        border: "1px dashed var(--border-weak)",
        "border-radius": "8px",
        color: "var(--text-weak)"
      }}>
          Right click (or open) here
        </div>
      </mod.ContextMenu.Trigger>
      <mod.ContextMenu.Portal>
        <mod.ContextMenu.Content>
          <mod.ContextMenu.CheckboxItem checked>Show line numbers</mod.ContextMenu.CheckboxItem>
          <mod.ContextMenu.CheckboxItem>Wrap lines</mod.ContextMenu.CheckboxItem>
          <mod.ContextMenu.Separator />
          <mod.ContextMenu.RadioGroup value="compact">
            <mod.ContextMenu.RadioItem value="compact">Compact</mod.ContextMenu.RadioItem>
            <mod.ContextMenu.RadioItem value="comfortable">Comfortable</mod.ContextMenu.RadioItem>
          </mod.ContextMenu.RadioGroup>
        </mod.ContextMenu.Content>
      </mod.ContextMenu.Portal>
    </mod.ContextMenu>
}`,...l.parameters?.docs?.source}}};const V=["Basic","CheckboxRadio"];export{u as Basic,l as CheckboxRadio,V as __namedExportsOrder,E as default};
