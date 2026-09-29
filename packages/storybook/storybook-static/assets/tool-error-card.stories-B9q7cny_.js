import{i as l,b as a,t as i}from"./iframe-D288tw9h.js";import{T as o}from"./tool-error-card-DsXG3ruf.js";import"./preload-helper-D9Z9MdNV.js";import"./card-iNRH_RhR.js";import"./icon-BG5j3Qjr.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./inline-svg-sprite-SZycwMcv.js";import"./collapsible-Du8zhFL1.js";import"./UGE6PPGT-C6B63Gso.js";import"./icon-button-C_HG_auw.js";import"./tooltip-3OGsQ03U.js";import"./U2LDQJ3A-CDgGg6L7.js";import"./OGE3DKII-BkPGJFio.js";import"./LP6E37CW-BgXoIsgV.js";import"./i18n-CW9P7x91.js";var n=i("<div style=display:flex;flex-direction:column;gap:12px;max-width:720px>");const p=`### Overview
Tool call failure summary styled like a tool trigger.

### API
- Required: \`tool\` (tool id, e.g. apply_patch, bash)
- Required: \`error\` (error string)

### Behavior
- Collapsible; click header to expand/collapse.
`,s=[{tool:"apply_patch",error:"apply_patch verification failed: Failed to find expected lines in /Users/davidhill/Documents/Local/opencode/packages/ui/src/components/session-turn.tsx"},{tool:"bash",error:"bash Command failed: exit code 1: bun test --watch"},{tool:"read",error:"read File not found: /Users/davidhill/Documents/Local/opencode/packages/ui/src/components/does-not-exist.tsx"},{tool:"glob",error:"glob Pattern error: Invalid glob pattern: **/*["},{tool:"grep",error:"grep Regex error: Invalid regular expression: (unterminated group"},{tool:"webfetch",error:"webfetch Request failed: 502 Bad Gateway"},{tool:"websearch",error:"websearch Rate limited: Please try again in 30 seconds"},{tool:"question",error:"question Dismissed: user dismissed this question"}],T={title:"UI/ToolErrorCard",id:"components-tool-error-card",component:o,tags:["autodocs"],parameters:{docs:{description:{component:p}}},args:{tool:"apply_patch",error:s[0].error},argTypes:{tool:{control:"select",options:["apply_patch","bash","read","glob","grep","webfetch","websearch","question"]},error:{control:"text"}},render:e=>a(o,{get tool(){return e.tool},get error(){return e.error}})},r={render:()=>(()=>{var e=n();return l(e,()=>s.map(t=>a(o,{get tool(){return t.tool},get error(){return t.error}}))),e})()};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{code:`const All = () => {
  return (
    <div style="display: flex; flex-direction: column; gap: 12px; max-width: 720px;">
      {samples.map((item) => (
        <ToolErrorCard tool={item.tool} error={item.error} />
      ))}
    </div>
  );
};
`,...r.parameters?.docs?.source}}};r.parameters={...r.parameters,docs:{...r.parameters?.docs,source:{originalSource:`{
  render: () => {
    return <div style="display: flex; flex-direction: column; gap: 12px; max-width: 720px;">
        {samples.map(item => <ToolErrorCard tool={item.tool} error={item.error} />)}
      </div>;
  }
}`,...r.parameters?.docs?.source}}};const E=["All"];export{r as All,E as __namedExportsOrder,T as default};
