import{i as s,t as i,b as l}from"./iframe-D288tw9h.js";import{m,F as y}from"./file-icon-CrT71WKR.js";import{c as f}from"./scaffold-D1dWsSla.js";import"./preload-helper-D9Z9MdNV.js";import"./inline-svg-sprite-SZycwMcv.js";var h=i('<div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill, minmax(120px, 1fr))">'),g=i("<div style=display:flex;gap:8px;align-items:center><div style=font-size:12px;color:var(--text-weak)>");const x=`### Overview
File and folder icon renderer based on file name and extension.

Use in file trees and lists.

### API
- Required: \`node\` with \`path\` and \`type\`.
- Optional: \`expanded\` (for folders), \`mono\` for monochrome rendering.

### Variants and states
- Folder vs file icons; expanded folder variant.

### Behavior
- Maps file names and extensions to sprite icons.

### Accessibility
- Provide adjacent text labels for filenames; icons are decorative.

### Theming/tokens
- Uses \`data-component="file-icon"\` and sprite-based styling.

`,c=f({title:"UI/FileIcon",mod:m,args:{node:{path:"package.json",type:"file"},mono:!0}}),j={title:"UI/FileIcon",id:"components-file-icon",component:c.meta.component,tags:["autodocs"],parameters:{docs:{description:{component:x}}}},e=c.Basic,t={args:{node:{path:"src",type:"directory"},expanded:!0,mono:!1}},n={render:()=>{const d=[{path:"README.md",type:"file"},{path:"package.json",type:"file"},{path:"tsconfig.json",type:"file"},{path:"index.ts",type:"file"},{path:"styles.css",type:"file"},{path:"logo.svg",type:"file"},{path:"photo.png",type:"file"},{path:"Dockerfile",type:"file"},{path:".env",type:"file"},{path:"src",type:"directory"},{path:"public",type:"directory"}];return(()=>{var r=h();return s(r,()=>d.map(a=>(()=>{var o=g(),p=o.firstChild;return s(o,l(y,{get node(){return{path:a.path,type:a.type}},mono:!1}),p),s(p,()=>a.path),o})())),r})()}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{code:`Expected story to be csf factory, function or an object expression
  49 | }
  50 |
> 51 | export const Basic = story.Basic
     |                      ^^^^^^^^^^^
  52 |
  53 | export const Folder = {
  54 |   args: {`,...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{code:`const Folder = () => (
  <story.meta.component
    node={{ path: "src", type: "directory" }}
    expanded
    mono={false}
  />
);
`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{code:`const Samples = () => {
  const items = [
    { path: "README.md", type: "file" },
    { path: "package.json", type: "file" },
    { path: "tsconfig.json", type: "file" },
    { path: "index.ts", type: "file" },
    { path: "styles.css", type: "file" },
    { path: "logo.svg", type: "file" },
    { path: "photo.png", type: "file" },
    { path: "Dockerfile", type: "file" },
    { path: ".env", type: "file" },
    { path: "src", type: "directory" },
    { path: "public", type: "directory" },
  ] as const;

  return (
    <div
      style={{
        display: "grid",
        gap: "12px",
        "grid-template-columns": "repeat(auto-fill, minmax(120px, 1fr))",
      }}
    >
      {items.map((node) => (
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <mod.FileIcon
            node={{ path: node.path, type: node.type }}
            mono={false}
          />
          <div style={{ "font-size": "12px", color: "var(--text-weak)" }}>
            {node.path}
          </div>
        </div>
      ))}
    </div>
  );
};
`,...n.parameters?.docs?.source}}};e.parameters={...e.parameters,docs:{...e.parameters?.docs,source:{originalSource:"story.Basic",...e.parameters?.docs?.source}}};t.parameters={...t.parameters,docs:{...t.parameters?.docs,source:{originalSource:`{
  args: {
    node: {
      path: "src",
      type: "directory"
    },
    expanded: true,
    mono: false
  }
}`,...t.parameters?.docs?.source}}};n.parameters={...n.parameters,docs:{...n.parameters?.docs,source:{originalSource:`{
  render: () => {
    const items = [{
      path: "README.md",
      type: "file"
    }, {
      path: "package.json",
      type: "file"
    }, {
      path: "tsconfig.json",
      type: "file"
    }, {
      path: "index.ts",
      type: "file"
    }, {
      path: "styles.css",
      type: "file"
    }, {
      path: "logo.svg",
      type: "file"
    }, {
      path: "photo.png",
      type: "file"
    }, {
      path: "Dockerfile",
      type: "file"
    }, {
      path: ".env",
      type: "file"
    }, {
      path: "src",
      type: "directory"
    }, {
      path: "public",
      type: "directory"
    }] as const;
    return <div style={{
      display: "grid",
      gap: "12px",
      "grid-template-columns": "repeat(auto-fill, minmax(120px, 1fr))"
    }}>
        {items.map(node => <div style={{
        display: "flex",
        gap: "8px",
        "align-items": "center"
      }}>
            <mod.FileIcon node={{
          path: node.path,
          type: node.type
        }} mono={false} />
            <div style={{
          "font-size": "12px",
          color: "var(--text-weak)"
        }}>{node.path}</div>
          </div>)}
      </div>;
  }
}`,...n.parameters?.docs?.source}}};const I=["Basic","Folder","Samples"];export{e as Basic,t as Folder,n as Samples,I as __namedExportsOrder,j as default};
