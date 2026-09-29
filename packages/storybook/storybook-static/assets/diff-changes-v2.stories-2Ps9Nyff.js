import{D as n}from"./diff-changes-v2-CLFAeji0.js";import"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";const o=`### Overview  
Summarize additions/deletions as compact text.

Pair with \`Diff\`/\`DiffSSR\` to contextualize a change set.

### API
- Required: \`changes\` as { additions, deletions } or an array of those objects.

### Variants and states
- Handles zero-change state (renders nothing).

### Behavior
- Aggregates arrays into total additions/deletions.

### Accessibility
- Ensure surrounding context conveys meaning of the counts/bars.

### Theming/tokens
- Uses \`data-component="diff-changes"\` and diff color tokens.

`,t={additions:12,deletions:5},c={title:"UI V2/DiffChanges",id:"components-diff-changes-v2",component:n,tags:["autodocs"],parameters:{docs:{description:{component:o}}},args:{changes:t}},e={},s={args:{changes:[{additions:4,deletions:1},{additions:8,deletions:3},{additions:2,deletions:0}]}},a={args:{changes:{additions:0,deletions:0}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`const Default = () => <DiffChanges changes={changes} />;
`,...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{code:`const MultipleFiles = () => (
  <DiffChanges
    changes={[
      { additions: 4, deletions: 1 },
      { additions: 8, deletions: 3 },
      { additions: 2, deletions: 0 },
    ]}
  />
);
`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{code:`const Zero = () => <DiffChanges changes={{ additions: 0, deletions: 0 }} />;
`,...a.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"{}",...e.parameters?.docs?.source}}};s.parameters={...s.parameters,docs:{...s.parameters?.docs,source:{originalSource:`{
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
}`,...s.parameters?.docs?.source}}};a.parameters={...a.parameters,docs:{...a.parameters?.docs,source:{originalSource:`{
  args: {
    changes: {
      additions: 0,
      deletions: 0
    }
  }
}`,...a.parameters?.docs?.source}}};const m=["Default","MultipleFiles","Zero"];export{e as Default,s as MultipleFiles,a as Zero,m as __namedExportsOrder,c as default};
