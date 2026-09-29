import{D as o}from"./dropdown-menu-DU__CkY-.js";import{B as d}from"./button-Bsz0PTzb.js";import{b as n}from"./iframe-D288tw9h.js";import"./WT65CSSX-CbPMWqT3.js";import"./T4C3DMHT-DBumxLXp.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./DAEKM6TG-BBrc5b-v.js";import"./AGCGV7T6-D4ycykph.js";import"./SOM3K36D-DFQE1dRQ.js";import"./VI7QYH27-BdSgIyCK.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./preload-helper-D9Z9MdNV.js";const t='### Overview\nDropdown menu built on Kobalte with composable items, groups, and submenus.\n\nUse `DropdownMenu.ItemLabel`/`ItemDescription` for richer rows.\n\n### API\n- Root accepts Kobalte DropdownMenu props (`open`, `defaultOpen`, `onOpenChange`).\n- Compose with `Trigger`, `Content`, `Item`, `Separator`, and optional `Sub` sections.\n\n### Variants and states\n- Supports item groups, separators, and nested submenus.\n\n### Behavior\n- Menu opens from trigger and renders in a portal by default.\n\n### Accessibility\n- TODO: confirm keyboard navigation from Kobalte.\n\n### Theming/tokens\n- Uses `data-component="dropdown-menu"` and slot attributes for styling.\n\n',C={title:"UI/DropdownMenu",id:"components-dropdown-menu",component:o,tags:["autodocs"],parameters:{docs:{description:{component:t}}}},e={render:()=>n(o,{defaultOpen:!0,get children(){return[n(o.Trigger,{as:d,variant:"secondary",size:"small",children:"Open menu"}),n(o.Portal,{get children(){return n(o.Content,{get children(){return[n(o.Group,{get children(){return[n(o.GroupLabel,{children:"Actions"}),n(o.Item,{get children(){return n(o.ItemLabel,{children:"New file"})}}),n(o.Item,{get children(){return[n(o.ItemLabel,{children:"Rename"}),n(o.ItemDescription,{children:"Shift+R"})]}})]}}),n(o.Separator,{}),n(o.Sub,{get children(){return[n(o.SubTrigger,{children:"More options"}),n(o.SubContent,{get children(){return[n(o.Item,{get children(){return n(o.ItemLabel,{children:"Duplicate"})}}),n(o.Item,{get children(){return n(o.ItemLabel,{children:"Move"})}})]}})]}})]}})}})]}})},r={render:()=>n(o,{defaultOpen:!0,get children(){return[n(o.Trigger,{as:d,variant:"secondary",size:"small",children:"Open menu"}),n(o.Portal,{get children(){return n(o.Content,{get children(){return[n(o.CheckboxItem,{checked:!0,children:"Show line numbers"}),n(o.CheckboxItem,{children:"Wrap lines"}),n(o.Separator,{}),n(o.RadioGroup,{value:"compact",get children(){return[n(o.RadioItem,{value:"compact",children:"Compact"}),n(o.RadioItem,{value:"comfortable",children:"Comfortable"})]}})]}})}})]}})};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Basic = () => (
  <mod.DropdownMenu defaultOpen>
    <mod.DropdownMenu.Trigger as={Button} variant="secondary" size="small">
      Open menu
    </mod.DropdownMenu.Trigger>
    <mod.DropdownMenu.Portal>
      <mod.DropdownMenu.Content>
        <mod.DropdownMenu.Group>
          <mod.DropdownMenu.GroupLabel>Actions</mod.DropdownMenu.GroupLabel>
          <mod.DropdownMenu.Item>
            <mod.DropdownMenu.ItemLabel>New file</mod.DropdownMenu.ItemLabel>
          </mod.DropdownMenu.Item>
          <mod.DropdownMenu.Item>
            <mod.DropdownMenu.ItemLabel>Rename</mod.DropdownMenu.ItemLabel>
            <mod.DropdownMenu.ItemDescription>
              Shift+R
            </mod.DropdownMenu.ItemDescription>
          </mod.DropdownMenu.Item>
        </mod.DropdownMenu.Group>
        <mod.DropdownMenu.Separator />
        <mod.DropdownMenu.Sub>
          <mod.DropdownMenu.SubTrigger>
            More options
          </mod.DropdownMenu.SubTrigger>
          <mod.DropdownMenu.SubContent>
            <mod.DropdownMenu.Item>
              <mod.DropdownMenu.ItemLabel>Duplicate</mod.DropdownMenu.ItemLabel>
            </mod.DropdownMenu.Item>
            <mod.DropdownMenu.Item>
              <mod.DropdownMenu.ItemLabel>Move</mod.DropdownMenu.ItemLabel>
            </mod.DropdownMenu.Item>
          </mod.DropdownMenu.SubContent>
        </mod.DropdownMenu.Sub>
      </mod.DropdownMenu.Content>
    </mod.DropdownMenu.Portal>
  </mod.DropdownMenu>
);
`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const CheckboxRadio = () => (
  <mod.DropdownMenu defaultOpen>
    <mod.DropdownMenu.Trigger as={Button} variant="secondary" size="small">
      Open menu
    </mod.DropdownMenu.Trigger>
    <mod.DropdownMenu.Portal>
      <mod.DropdownMenu.Content>
        <mod.DropdownMenu.CheckboxItem checked>
          Show line numbers
        </mod.DropdownMenu.CheckboxItem>
        <mod.DropdownMenu.CheckboxItem>
          Wrap lines
        </mod.DropdownMenu.CheckboxItem>
        <mod.DropdownMenu.Separator />
        <mod.DropdownMenu.RadioGroup value="compact">
          <mod.DropdownMenu.RadioItem value="compact">
            Compact
          </mod.DropdownMenu.RadioItem>
          <mod.DropdownMenu.RadioItem value="comfortable">
            Comfortable
          </mod.DropdownMenu.RadioItem>
        </mod.DropdownMenu.RadioGroup>
      </mod.DropdownMenu.Content>
    </mod.DropdownMenu.Portal>
  </mod.DropdownMenu>
);
`,...r.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:`{
  render: () => <mod.DropdownMenu defaultOpen>
      <mod.DropdownMenu.Trigger as={Button} variant="secondary" size="small">
        Open menu
      </mod.DropdownMenu.Trigger>
      <mod.DropdownMenu.Portal>
        <mod.DropdownMenu.Content>
          <mod.DropdownMenu.Group>
            <mod.DropdownMenu.GroupLabel>Actions</mod.DropdownMenu.GroupLabel>
            <mod.DropdownMenu.Item>
              <mod.DropdownMenu.ItemLabel>New file</mod.DropdownMenu.ItemLabel>
            </mod.DropdownMenu.Item>
            <mod.DropdownMenu.Item>
              <mod.DropdownMenu.ItemLabel>Rename</mod.DropdownMenu.ItemLabel>
              <mod.DropdownMenu.ItemDescription>Shift+R</mod.DropdownMenu.ItemDescription>
            </mod.DropdownMenu.Item>
          </mod.DropdownMenu.Group>
          <mod.DropdownMenu.Separator />
          <mod.DropdownMenu.Sub>
            <mod.DropdownMenu.SubTrigger>More options</mod.DropdownMenu.SubTrigger>
            <mod.DropdownMenu.SubContent>
              <mod.DropdownMenu.Item>
                <mod.DropdownMenu.ItemLabel>Duplicate</mod.DropdownMenu.ItemLabel>
              </mod.DropdownMenu.Item>
              <mod.DropdownMenu.Item>
                <mod.DropdownMenu.ItemLabel>Move</mod.DropdownMenu.ItemLabel>
              </mod.DropdownMenu.Item>
            </mod.DropdownMenu.SubContent>
          </mod.DropdownMenu.Sub>
        </mod.DropdownMenu.Content>
      </mod.DropdownMenu.Portal>
    </mod.DropdownMenu>
}`,...e.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => <mod.DropdownMenu defaultOpen>
      <mod.DropdownMenu.Trigger as={Button} variant="secondary" size="small">
        Open menu
      </mod.DropdownMenu.Trigger>
      <mod.DropdownMenu.Portal>
        <mod.DropdownMenu.Content>
          <mod.DropdownMenu.CheckboxItem checked>Show line numbers</mod.DropdownMenu.CheckboxItem>
          <mod.DropdownMenu.CheckboxItem>Wrap lines</mod.DropdownMenu.CheckboxItem>
          <mod.DropdownMenu.Separator />
          <mod.DropdownMenu.RadioGroup value="compact">
            <mod.DropdownMenu.RadioItem value="compact">Compact</mod.DropdownMenu.RadioItem>
            <mod.DropdownMenu.RadioItem value="comfortable">Comfortable</mod.DropdownMenu.RadioItem>
          </mod.DropdownMenu.RadioGroup>
        </mod.DropdownMenu.Content>
      </mod.DropdownMenu.Portal>
    </mod.DropdownMenu>
}`,...r.parameters?.docs?.source}}};const S=["Basic","CheckboxRadio"];export{e as Basic,r as CheckboxRadio,S as __namedExportsOrder,C as default};
