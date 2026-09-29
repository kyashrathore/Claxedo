import{s as D,I as O,m as B,t as u,c as S,i as x,b as v,K as h,Z as P,x as U,a9 as b}from"./iframe-D288tw9h.js";import"./preload-helper-D9Z9MdNV.js";var V=u("<div>");function z(s){const[e,n]=D(s,["direction","edge","size","min","max","onResize","onCollapse","onCollapseChange","collapseThreshold","class","classList"]),r=t=>{if(t.detail>1)return;t.preventDefault();const a=e.edge??(e.direction==="vertical"?"start":"end"),i=e.direction==="horizontal"?t.clientX:t.clientY,o=e.size,H=e.min,E=e.max,k=e.collapseThreshold??0,T=e.onResize,L=e.onCollapse,$=e.onCollapseChange;let y=o,g=!1;document.body.style.userSelect="none",document.body.style.overflow="hidden";const f=_=>{const m=e.direction==="horizontal"?_.clientX:_.clientY,M=e.direction==="vertical"?a==="end"?m-i:i-m:a==="start"?i-m:m-i;y=o+M;const R=k>0&&y<k;R!==g&&(g=R,$?.(g)),T(Math.min(E,Math.max(H,y)))},w=()=>{if(document.body.style.userSelect="",document.body.style.overflow="",document.removeEventListener("mousemove",f),document.removeEventListener("mouseup",w),g){L?.();return}$?.(!1)};document.addEventListener("mousemove",f),document.addEventListener("mouseup",w)};return(()=>{var t=V();return O(t,B(n,{"data-component":"resize-handle",get"data-direction"(){return e.direction},get"data-edge"(){return e.edge??(e.direction==="vertical"?"start":"end")},get classList(){return{"ui-resize-handle":!0,...e.classList,[e.class??""]:!!e.class}},onMouseDown:r}),!1,!1),t})()}var C=u("<div style=display:grid;gap:8px><div style=color:var(--text-weak);font-size:12px>Size: <!>px</div><div style=height:48px;background-color:var(--background-stronger);border-radius:6px>"),I=u("<div style=display:grid;gap:8px;width:220px><div style=color:var(--text-weak);font-size:12px>Size: <!>px</div><div style=background-color:var(--background-stronger);border-radius:6px>"),A=u("<div style=display:grid;gap:8px><div style=color:var(--text-weak);font-size:12px></div><div style=height:48px;background-color:var(--background-stronger);border-radius:6px>");const X=`### Overview
Drag handle for resizing panels or split views.

Use alongside resizable panels and split layouts.

### API
- Required: \`direction\`, \`size\`, \`min\`, \`max\`, \`onResize\`.
- Optional: \`edge\`, \`onCollapse\`, \`collapseThreshold\`.

### Variants and states
- Horizontal and vertical directions.

### Behavior
- Drag updates size and calls \`onResize\` with clamped values.

### Accessibility
- TODO: provide keyboard resizing guidance if needed.

### Theming/tokens
- Uses \`data-component="resize-handle"\` with direction/edge data attributes.

`,K={title:"UI/ResizeHandle",id:"components-resize-handle",component:z,tags:["autodocs"],parameters:{docs:{description:{component:X}}}},d={render:()=>{const[s,e]=S(240);return(()=>{var n=C(),r=n.firstChild,t=r.firstChild,a=t.nextSibling;a.nextSibling;var i=r.nextSibling;return x(r,s,a),x(n,v(z,{direction:"horizontal",get size(){return s()},min:120,max:480,onResize:e,style:"height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"}),null),h(o=>b(i,"width",`${s()}px`)),n})()}},l={render:()=>{const[s,e]=S(180);return(()=>{var n=I(),r=n.firstChild,t=r.firstChild,a=t.nextSibling;a.nextSibling;var i=r.nextSibling;return x(r,s,a),x(n,v(z,{direction:"vertical",get size(){return s()},min:120,max:320,onResize:e,style:"width:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"}),null),h(o=>b(i,"height",`${s()}px`)),n})()}},c={render:()=>{const[s,e]=P({size:200,collapsed:!1}),n=()=>s.size,r=()=>s.collapsed;return(()=>{var t=A(),a=t.firstChild,i=a.nextSibling;return x(a,(()=>{var o=U(()=>!!r());return()=>o()?"Collapsed":`Size: ${n()}px`})()),x(t,v(z,{direction:"horizontal",get size(){return n()},min:80,max:360,collapseThreshold:100,onResize:o=>{e("collapsed",!1),e("size",o)},onCollapse:()=>e("collapsed",!0),style:"height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"}),null),h(o=>b(i,"width",`${r()?0:n()}px`)),t})()}},p={render:()=>{const[s,e]=S(240);return(()=>{var n=C(),r=n.firstChild,t=r.firstChild,a=t.nextSibling;a.nextSibling;var i=r.nextSibling;return x(r,s,a),x(n,v(z,{direction:"horizontal",edge:"start",get size(){return s()},min:120,max:480,onResize:e,style:"height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"}),null),h(o=>b(i,"width",`${s()}px`)),n})()}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{code:`const Basic = () => {
  const [size, setSize] = createSignal(240);
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Size: {size()}px
      </div>
      <div
        style={{
          width: \`\${size()}px\`,
          height: "48px",
          "background-color": "var(--background-stronger)",
          "border-radius": "6px",
        }}
      />
      <mod.ResizeHandle
        direction="horizontal"
        size={size()}
        min={120}
        max={480}
        onResize={setSize}
        style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"
      />
    </div>
  );
};
`,...d.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{code:`const Vertical = () => {
  const [size, setSize] = createSignal(180);
  return (
    <div style={{ display: "grid", gap: "8px", width: "220px" }}>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Size: {size()}px
      </div>
      <div
        style={{
          height: \`\${size()}px\`,
          "background-color": "var(--background-stronger)",
          "border-radius": "6px",
        }}
      />
      <mod.ResizeHandle
        direction="vertical"
        size={size()}
        min={120}
        max={320}
        onResize={setSize}
        style="width:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"
      />
    </div>
  );
};
`,...l.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{code:`const Collapse = () => {
  const [state, setState] = createStore({
    size: 200,
    collapsed: false,
  });
  const size = () => state.size;
  const collapsed = () => state.collapsed;
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        {collapsed() ? "Collapsed" : \`Size: \${size()}px\`}
      </div>
      <div
        style={{
          width: \`\${collapsed() ? 0 : size()}px\`,
          height: "48px",
          "background-color": "var(--background-stronger)",
          "border-radius": "6px",
        }}
      />
      <mod.ResizeHandle
        direction="horizontal"
        size={size()}
        min={80}
        max={360}
        collapseThreshold={100}
        onResize={(next) => {
          setState("collapsed", false);
          setState("size", next);
        }}
        onCollapse={() => setState("collapsed", true)}
        style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"
      />
    </div>
  );
};
`,...c.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const EdgeStart = () => {
  const [size, setSize] = createSignal(240);
  return (
    <div style={{ display: "grid", gap: "8px" }}>
      <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>
        Size: {size()}px
      </div>
      <div
        style={{
          width: \`\${size()}px\`,
          height: "48px",
          "background-color": "var(--background-stronger)",
          "border-radius": "6px",
        }}
      />
      <mod.ResizeHandle
        direction="horizontal"
        edge="start"
        size={size()}
        min={120}
        max={480}
        onResize={setSize}
        style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)"
      />
    </div>
  );
};
`,...p.parameters?.docs?.source}}};d.parameters={...d.parameters,docs:{...d.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [size, setSize] = createSignal(240);
    return <div style={{
      display: "grid",
      gap: "8px"
    }}>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Size: {size()}px</div>
        <div style={{
        width: \`\${size()}px\`,
        height: "48px",
        "background-color": "var(--background-stronger)",
        "border-radius": "6px"
      }} />
        <mod.ResizeHandle direction="horizontal" size={size()} min={120} max={480} onResize={setSize} style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)" />
      </div>;
  }
}`,...d.parameters?.docs?.source}}};l.parameters={...l.parameters,docs:{...l.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [size, setSize] = createSignal(180);
    return <div style={{
      display: "grid",
      gap: "8px",
      width: "220px"
    }}>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Size: {size()}px</div>
        <div style={{
        height: \`\${size()}px\`,
        "background-color": "var(--background-stronger)",
        "border-radius": "6px"
      }} />
        <mod.ResizeHandle direction="vertical" size={size()} min={120} max={320} onResize={setSize} style="width:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)" />
      </div>;
  }
}`,...l.parameters?.docs?.source}}};c.parameters={...c.parameters,docs:{...c.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [state, setState] = createStore({
      size: 200,
      collapsed: false
    });
    const size = () => state.size;
    const collapsed = () => state.collapsed;
    return <div style={{
      display: "grid",
      gap: "8px"
    }}>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>
          {collapsed() ? "Collapsed" : \`Size: \${size()}px\`}
        </div>
        <div style={{
        width: \`\${collapsed() ? 0 : size()}px\`,
        height: "48px",
        "background-color": "var(--background-stronger)",
        "border-radius": "6px"
      }} />
        <mod.ResizeHandle direction="horizontal" size={size()} min={80} max={360} collapseThreshold={100} onResize={next => {
        setState("collapsed", false);
        setState("size", next);
      }} onCollapse={() => setState("collapsed", true)} style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)" />
      </div>;
  }
}`,...c.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [size, setSize] = createSignal(240);
    return <div style={{
      display: "grid",
      gap: "8px"
    }}>
        <div style={{
        color: "var(--text-weak)",
        "font-size": "12px"
      }}>Size: {size()}px</div>
        <div style={{
        width: \`\${size()}px\`,
        height: "48px",
        "background-color": "var(--background-stronger)",
        "border-radius": "6px"
      }} />
        <mod.ResizeHandle direction="horizontal" edge="start" size={size()} min={120} max={480} onResize={setSize} style="height:24px;border:1px dashed color-mix(in oklab, var(--text-base) 20%, transparent)" />
      </div>;
  }
}`,...p.parameters?.docs?.source}}};const Z=["Basic","Vertical","Collapse","EdgeStart"];export{d as Basic,c as Collapse,p as EdgeStart,l as Vertical,Z as __namedExportsOrder,K as default};
