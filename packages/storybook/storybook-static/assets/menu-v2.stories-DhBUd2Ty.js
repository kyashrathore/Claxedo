import{b as e,c,t as I}from"./iframe-D288tw9h.js";import{M as n}from"./menu-v2-XVy5jDcM.js";import{B as m}from"./button-v2-DbG8OeJh.js";import{A as V}from"./avatar-v2-OOiGnRRK.js";import{I as t}from"./icon-CFIdCkfs.js";import"./preload-helper-D9Z9MdNV.js";import"./WT65CSSX-CbPMWqT3.js";import"./T4C3DMHT-DBumxLXp.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./SOM3K36D-DFQE1dRQ.js";import"./VI7QYH27-BdSgIyCK.js";import"./UMC5UGBH-VRUJmC09.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";var C=I('<div style="display:flex;align-items:center;justify-content:center;width:320px;height:180px;border-radius:8px;border:1px dashed rgba(0, 0, 0, 0.2);color:#5c5c5c;font-size:13px;font-family:var(--v2-font-family-sans);user-select:none">Right-click this area');const b="### Overview\nComposable menu primitive built on Kobalte's `DropdownMenu` and `ContextMenu`. The same item components (`Item`, `CheckboxItem`, `RadioItem`, `SubTrigger`) work inside either container.\n\n### API\n- `MenuV2` / `MenuV2.Trigger` / `MenuV2.Portal` / `MenuV2.Content` — dropdown root + popper plumbing.\n- `MenuV2.Context` namespace mirrors the same shape for right-click menus.\n- `MenuV2.Item` — supports a freeform `children` slot (avatar, icon, text — whatever) plus `shortcut` and `badge` props.\n- `MenuV2.CheckboxItem` / `MenuV2.RadioItem` — same item shape; auto-render a check indicator that turns blue when selected.\n- `MenuV2.Sub` / `MenuV2.SubTrigger` / `MenuV2.SubContent` — nested submenus; `SubTrigger` auto-renders the trailing chevron.\n\n### Behavior\n- Items expose Kobalte's data attributes — `data-highlighted`, `data-checked`, `data-disabled`.\n- Blue selected state is reserved for `CheckboxItem` / `RadioItem` (the rest just highlight on hover).\n- Chevron is only rendered on `SubTrigger`.\n",j={title:"UI V2/Menu",id:"components-menu-v2",component:n,tags:["autodocs"],parameters:{frameHeight:"360px",frameBackground:"#fff",docs:{description:{component:b}}}},r={render:()=>e(n,{gutter:6,get children(){return[e(n.Trigger,{as:m,children:"Open menu"}),e(n.Portal,{get children(){return e(n.Content,{get children(){return[e(n.Item,{children:"New file"}),e(n.Item,{children:"Open file"}),e(n.Item,{children:"Save"}),e(n.Separator,{}),e(n.Item,{disabled:!0,children:"Print"})]}})}})]}})},a={render:()=>e(n,{gutter:6,get children(){return[e(n.Trigger,{as:m,children:"Open rich menu"}),e(n.Portal,{get children(){return e(n.Content,{style:{"min-width":"240px"},get children(){return[e(n.Item,{shortcut:"⇧ D",badge:"Label",get children(){return[e(V,{size:"small",kind:"org",fallback:"A"}),e(t,{name:"settings",size:"small"}),"Text"]}}),e(n.Item,{shortcut:"⌘ N",get children(){return[e(t,{name:"plus",size:"small"}),"New window"]}}),e(n.Item,{shortcut:"⌘ S",badge:"Beta",get children(){return[e(t,{name:"save",size:"small"}),"Save as…"]}}),e(n.Separator,{}),e(n.Item,{disabled:!0,shortcut:"⌘ P",get children(){return[e(t,{name:"print",size:"small"}),"Print"]}})]}})}})]}})},u={render:()=>{const[l,d]=c(!0),[M,h]=c(!1),[p,g]=c(!1);return e(n,{gutter:6,get children(){return[e(n.Trigger,{as:m,children:"View"}),e(n.Portal,{get children(){return e(n.Content,{style:{"min-width":"200px"},get children(){return[e(n.CheckboxItem,{get checked(){return l()},onChange:d,shortcut:"⌥ Z",children:"Word wrap"}),e(n.CheckboxItem,{get checked(){return M()},onChange:h,children:"Minimap"}),e(n.CheckboxItem,{get checked(){return p()},onChange:g,disabled:!0,children:"Ruler"})]}})}})]}})}},o={render:()=>{const[l,d]=c("system");return e(n,{gutter:6,get children(){return[e(n.Trigger,{as:m,children:"Theme"}),e(n.Portal,{get children(){return e(n.Content,{style:{"min-width":"200px"},get children(){return e(n.Group,{get children(){return[e(n.GroupLabel,{children:"Appearance"}),e(n.RadioGroup,{get value(){return l()},onChange:d,get children(){return[e(n.RadioItem,{value:"light",children:"Light"}),e(n.RadioItem,{value:"dark",children:"Dark"}),e(n.RadioItem,{value:"system",badge:"Auto",children:"System"})]}})]}})}})}})]}})}},s={render:()=>e(n,{gutter:6,get children(){return[e(n.Trigger,{as:m,children:"File"}),e(n.Portal,{get children(){return e(n.Content,{style:{"min-width":"200px"},get children(){return[e(n.Item,{shortcut:"⌘ N",children:"New file"}),e(n.Item,{shortcut:"⌘ O",children:"Open file"}),e(n.Sub,{gutter:0,get children(){return[e(n.SubTrigger,{children:"Open recent"}),e(n.Portal,{get children(){return e(n.SubContent,{get children(){return[e(n.Item,{children:"project-alpha.tsx"}),e(n.Item,{children:"project-beta.tsx"}),e(n.Item,{children:"project-gamma.tsx"}),e(n.Separator,{}),e(n.Item,{children:"Clear recent"})]}})}})]}}),e(n.Separator,{}),e(n.Item,{shortcut:"⌘ S",children:"Save"}),e(n.Item,{shortcut:"⇧⌘ S",children:"Save as…"})]}})}})]}})},i={render:()=>e(n.Context,{gutter:6,get children(){return[e(n.Context.Trigger,{get children(){return C()}}),e(n.Context.Portal,{get children(){return e(n.Context.Content,{style:{"min-width":"200px"},get children(){return[e(n.Item,{shortcut:"⌘ C",get children(){return[e(V,{size:"small",kind:"org",fallback:"C"}),"Copy"]}}),e(n.Item,{shortcut:"⌘ X",get children(){return[e(t,{name:"cut",size:"small"}),"Cut"]}}),e(n.Item,{shortcut:"⌘ V",get children(){return[e(t,{name:"paste",size:"small"}),"Paste"]}}),e(n.Separator,{}),e(n.Item,{badge:"New",get children(){return[e(t,{name:"inspect",size:"small"}),"Inspect element"]}}),e(n.Item,{disabled:!0,get children(){return[e(t,{name:"trash",size:"small"}),"Delete"]}})]}})}})]}})};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const Basic = () => (
  <MenuV2 gutter={6}>
    <MenuV2.Trigger as={ButtonV2}>Open menu</MenuV2.Trigger>
    <MenuV2.Portal>
      <MenuV2.Content>
        <MenuV2.Item>New file</MenuV2.Item>
        <MenuV2.Item>Open file</MenuV2.Item>
        <MenuV2.Item>Save</MenuV2.Item>
        <MenuV2.Separator />
        <MenuV2.Item disabled>Print</MenuV2.Item>
      </MenuV2.Content>
    </MenuV2.Portal>
  </MenuV2>
);
`,...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Rich = () => (
  <MenuV2 gutter={6}>
    <MenuV2.Trigger as={ButtonV2}>Open rich menu</MenuV2.Trigger>
    <MenuV2.Portal>
      <MenuV2.Content style={{ "min-width": "240px" }}>
        <MenuV2.Item shortcut="⇧ D" badge="Label">
          <Avatar size="small" kind="org" fallback="A" />
          <Icon name="settings" size="small" />
          Text
        </MenuV2.Item>
        <MenuV2.Item shortcut="⌘ N">
          <Icon name="plus" size="small" />
          New window
        </MenuV2.Item>
        <MenuV2.Item shortcut="⌘ S" badge="Beta">
          <Icon name="save" size="small" />
          Save as…
        </MenuV2.Item>
        <MenuV2.Separator />
        <MenuV2.Item disabled shortcut="⌘ P">
          <Icon name="print" size="small" />
          Print
        </MenuV2.Item>
      </MenuV2.Content>
    </MenuV2.Portal>
  </MenuV2>
);
`,...a.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{code:`const WithCheckbox = () => {
  const [wrap, setWrap] = createSignal(true);
  const [minimap, setMinimap] = createSignal(false);
  const [ruler, setRuler] = createSignal(false);
  return (
    <MenuV2 gutter={6}>
      <MenuV2.Trigger as={ButtonV2}>View</MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content style={{ "min-width": "200px" }}>
          <MenuV2.CheckboxItem
            checked={wrap()}
            onChange={setWrap}
            shortcut="⌥ Z"
          >
            Word wrap
          </MenuV2.CheckboxItem>
          <MenuV2.CheckboxItem checked={minimap()} onChange={setMinimap}>
            Minimap
          </MenuV2.CheckboxItem>
          <MenuV2.CheckboxItem checked={ruler()} onChange={setRuler} disabled>
            Ruler
          </MenuV2.CheckboxItem>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  );
};
`,...u.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const WithRadio = () => {
  const [theme, setTheme] = createSignal("system");
  return (
    <MenuV2 gutter={6}>
      <MenuV2.Trigger as={ButtonV2}>Theme</MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content style={{ "min-width": "200px" }}>
          <MenuV2.Group>
            <MenuV2.GroupLabel>Appearance</MenuV2.GroupLabel>
            <MenuV2.RadioGroup value={theme()} onChange={setTheme}>
              <MenuV2.RadioItem value="light">Light</MenuV2.RadioItem>
              <MenuV2.RadioItem value="dark">Dark</MenuV2.RadioItem>
              <MenuV2.RadioItem value="system" badge="Auto">
                System
              </MenuV2.RadioItem>
            </MenuV2.RadioGroup>
          </MenuV2.Group>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  );
};
`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const WithSubmenu = () => (
  <MenuV2 gutter={6}>
    <MenuV2.Trigger as={ButtonV2}>File</MenuV2.Trigger>
    <MenuV2.Portal>
      <MenuV2.Content style={{ "min-width": "200px" }}>
        <MenuV2.Item shortcut="⌘ N">New file</MenuV2.Item>
        <MenuV2.Item shortcut="⌘ O">Open file</MenuV2.Item>
        <MenuV2.Sub gutter={0}>
          <MenuV2.SubTrigger>Open recent</MenuV2.SubTrigger>
          <MenuV2.Portal>
            <MenuV2.SubContent>
              <MenuV2.Item>project-alpha.tsx</MenuV2.Item>
              <MenuV2.Item>project-beta.tsx</MenuV2.Item>
              <MenuV2.Item>project-gamma.tsx</MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item>Clear recent</MenuV2.Item>
            </MenuV2.SubContent>
          </MenuV2.Portal>
        </MenuV2.Sub>
        <MenuV2.Separator />
        <MenuV2.Item shortcut="⌘ S">Save</MenuV2.Item>
        <MenuV2.Item shortcut="⇧⌘ S">Save as…</MenuV2.Item>
      </MenuV2.Content>
    </MenuV2.Portal>
  </MenuV2>
);
`,...s.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{code:`const Context = () => (
  <MenuV2.Context gutter={6}>
    <MenuV2.Context.Trigger>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          width: "320px",
          height: "180px",
          "border-radius": "8px",
          border: "1px dashed rgba(0, 0, 0, 0.2)",
          color: "#5c5c5c",
          "font-size": "13px",
          "font-family": "var(--v2-font-family-sans)",
          "user-select": "none",
        }}
      >
        Right-click this area
      </div>
    </MenuV2.Context.Trigger>
    <MenuV2.Context.Portal>
      <MenuV2.Context.Content style={{ "min-width": "200px" }}>
        <MenuV2.Item shortcut="⌘ C">
          <Avatar size="small" kind="org" fallback="C" />
          Copy
        </MenuV2.Item>
        <MenuV2.Item shortcut="⌘ X">
          <Icon name="cut" size="small" />
          Cut
        </MenuV2.Item>
        <MenuV2.Item shortcut="⌘ V">
          <Icon name="paste" size="small" />
          Paste
        </MenuV2.Item>
        <MenuV2.Separator />
        <MenuV2.Item badge="New">
          <Icon name="inspect" size="small" />
          Inspect element
        </MenuV2.Item>
        <MenuV2.Item disabled>
          <Icon name="trash" size="small" />
          Delete
        </MenuV2.Item>
      </MenuV2.Context.Content>
    </MenuV2.Context.Portal>
  </MenuV2.Context>
);
`,...i.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <MenuV2 gutter={6}>
      <MenuV2.Trigger as={ButtonV2}>Open menu</MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item>New file</MenuV2.Item>
          <MenuV2.Item>Open file</MenuV2.Item>
          <MenuV2.Item>Save</MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item disabled>Print</MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
}`,...r.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  render: () => <MenuV2 gutter={6}>
      <MenuV2.Trigger as={ButtonV2}>Open rich menu</MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content style={{
        "min-width": "240px"
      }}>
          <MenuV2.Item shortcut="⇧ D" badge="Label">
            <Avatar size="small" kind="org" fallback="A" />
            <Icon name="settings" size="small" />
            Text
          </MenuV2.Item>
          <MenuV2.Item shortcut="⌘ N">
            <Icon name="plus" size="small" />
            New window
          </MenuV2.Item>
          <MenuV2.Item shortcut="⌘ S" badge="Beta">
            <Icon name="save" size="small" />
            Save as…
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item disabled shortcut="⌘ P">
            <Icon name="print" size="small" />
            Print
          </MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
}`,...a.parameters?.docs?.source}}};u.parameters={...u.parameters,docs:{...u.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [wrap, setWrap] = createSignal(true);
    const [minimap, setMinimap] = createSignal(false);
    const [ruler, setRuler] = createSignal(false);
    return <MenuV2 gutter={6}>
        <MenuV2.Trigger as={ButtonV2}>View</MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content style={{
          "min-width": "200px"
        }}>
            <MenuV2.CheckboxItem checked={wrap()} onChange={setWrap} shortcut="⌥ Z">
              Word wrap
            </MenuV2.CheckboxItem>
            <MenuV2.CheckboxItem checked={minimap()} onChange={setMinimap}>
              Minimap
            </MenuV2.CheckboxItem>
            <MenuV2.CheckboxItem checked={ruler()} onChange={setRuler} disabled>
              Ruler
            </MenuV2.CheckboxItem>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>;
  }
}`,...u.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [theme, setTheme] = createSignal("system");
    return <MenuV2 gutter={6}>
        <MenuV2.Trigger as={ButtonV2}>Theme</MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content style={{
          "min-width": "200px"
        }}>
            <MenuV2.Group>
              <MenuV2.GroupLabel>Appearance</MenuV2.GroupLabel>
              <MenuV2.RadioGroup value={theme()} onChange={setTheme}>
                <MenuV2.RadioItem value="light">Light</MenuV2.RadioItem>
                <MenuV2.RadioItem value="dark">Dark</MenuV2.RadioItem>
                <MenuV2.RadioItem value="system" badge="Auto">
                  System
                </MenuV2.RadioItem>
              </MenuV2.RadioGroup>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>;
  }
}`,...o.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  render: () => <MenuV2 gutter={6}>
      <MenuV2.Trigger as={ButtonV2}>File</MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content style={{
        "min-width": "200px"
      }}>
          <MenuV2.Item shortcut="⌘ N">New file</MenuV2.Item>
          <MenuV2.Item shortcut="⌘ O">Open file</MenuV2.Item>
          <MenuV2.Sub gutter={0}>
            <MenuV2.SubTrigger>Open recent</MenuV2.SubTrigger>
            <MenuV2.Portal>
              <MenuV2.SubContent>
                <MenuV2.Item>project-alpha.tsx</MenuV2.Item>
                <MenuV2.Item>project-beta.tsx</MenuV2.Item>
                <MenuV2.Item>project-gamma.tsx</MenuV2.Item>
                <MenuV2.Separator />
                <MenuV2.Item>Clear recent</MenuV2.Item>
              </MenuV2.SubContent>
            </MenuV2.Portal>
          </MenuV2.Sub>
          <MenuV2.Separator />
          <MenuV2.Item shortcut="⌘ S">Save</MenuV2.Item>
          <MenuV2.Item shortcut="⇧⌘ S">Save as…</MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
}`,...s.parameters?.docs?.source}}};i.parameters={...i.parameters,docs:{...i.parameters?.docs,source:{originalSource:`{
  render: () => <MenuV2.Context gutter={6}>
      <MenuV2.Context.Trigger>
        <div style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        width: "320px",
        height: "180px",
        "border-radius": "8px",
        border: "1px dashed rgba(0, 0, 0, 0.2)",
        color: "#5c5c5c",
        "font-size": "13px",
        "font-family": "var(--v2-font-family-sans)",
        "user-select": "none"
      }}>
          Right-click this area
        </div>
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content style={{
        "min-width": "200px"
      }}>
          <MenuV2.Item shortcut="⌘ C">
            <Avatar size="small" kind="org" fallback="C" />
            Copy
          </MenuV2.Item>
          <MenuV2.Item shortcut="⌘ X">
            <Icon name="cut" size="small" />
            Cut
          </MenuV2.Item>
          <MenuV2.Item shortcut="⌘ V">
            <Icon name="paste" size="small" />
            Paste
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item badge="New">
            <Icon name="inspect" size="small" />
            Inspect element
          </MenuV2.Item>
          <MenuV2.Item disabled>
            <Icon name="trash" size="small" />
            Delete
          </MenuV2.Item>
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
}`,...i.parameters?.docs?.source}}};const L=["Basic","Rich","WithCheckbox","WithRadio","WithSubmenu","Context"];export{r as Basic,i as Context,a as Rich,u as WithCheckbox,o as WithRadio,s as WithSubmenu,L as __namedExportsOrder,j as default};
