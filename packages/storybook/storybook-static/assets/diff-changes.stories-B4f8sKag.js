import{m as r}from"./diff-changes-dWshtJQl.js";import{c as n}from"./scaffold-D1dWsSla.js";import{c as i}from"./fixtures-DjVgZSML.js";import"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";const c=`### Overview
Summarize additions/deletions as text or compact bars.

Pair with \`Diff\`/\`DiffSSR\` to contextualize a change set.

### API
- Required: \`changes\` as { additions, deletions } or an array of those objects.
- Optional: \`variant\` ("default" | "bars").

### Variants and states
- Default text summary or bar visualization.
- Handles zero-change state (renders nothing in default variant).

### Behavior
- Aggregates arrays into total additions/deletions.

### Accessibility
- Ensure surrounding context conveys meaning of the counts/bars.

### Theming/tokens
- Uses \`data-component="diff-changes"\` and diff color tokens.

`,t=n({title:"UI/DiffChanges",mod:r,args:{changes:i,variant:"default"}}),g={title:"UI/DiffChanges",id:"components-diff-changes",component:t.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:c}}},argTypes:{variant:{control:"select",options:["default","bars"]}}},e=t.Basic,s={args:{variant:"bars"}},a={args:{changes:[{additions:4,deletions:1},{additions:8,deletions:3},{additions:2,deletions:0}]}},o={args:{changes:{additions:0,deletions:0}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  57 | }
  58 |
> 59 | export const Default = story.Basic
     |                        ^^^^^^^^^^^
  60 |
  61 | export const Bars = {
  62 |   args: {`,...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const Bars = () => <story.meta.component variant="bars" />;
`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const MultipleFiles = () => (
  <story.meta.component
    changes={[
      { additions: 4, deletions: 1 },
      { additions: 8, deletions: 3 },
      { additions: 2, deletions: 0 },
    ]}
  />
);
`,...a.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{code:`const Zero = () => (
  <story.meta.component changes={{ additions: 0, deletions: 0 }} />
);
`,...o.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
  args: {
    variant: "bars"
  }
}`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  args: {
    changes: [{
      additions: 4,
      deletions: 1
    }, {
      additions: 8,
      deletions: 3
    }, {
      additions: 2,
      deletions: 0
    }]
  }
}`,...a.parameters?.docs?.source}}};o.parameters={...o.parameters,docs:{...o.parameters?.docs,source:{originalSource:`{
  args: {
    changes: {
      additions: 0,
      deletions: 0
    }
  }
}`,...o.parameters?.docs?.source}}};const f=["Default","Bars","MultipleFiles","Zero"];export{s as Bars,e as Default,a as MultipleFiles,o as Zero,f as __namedExportsOrder,g as default};
