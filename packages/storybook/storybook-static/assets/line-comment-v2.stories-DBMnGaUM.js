import{s as R,I as M,m as K,i as r,b as c,t as v,aa as G,S as O,c as H,o as J,ad as Q,V as X,K as F,L as A,x as Y}from"./iframe-D288tw9h.js";import{F as ee}from"./file-icon-CrT71WKR.js";import{B as P}from"./button-v2-DbG8OeJh.js";import{u as te}from"./use-filtered-list-XOqX6bHa.js";import"./preload-helper-D9Z9MdNV.js";import"./inline-svg-sprite-SZycwMcv.js";import"./icon-CFIdCkfs.js";import"./opencode-v2-artwork-Cyp9se-t.js";import"./map-B72Trknd.js";var ne=v('<svg><path d="M2.5 7.5H3.5V8.5H2.5V7.5Z"stroke=currentColor></path><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z"stroke=currentColor></path><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z"stroke=currentColor>'),oe=v("<div><div data-slot=line-comment-v2-shell><div data-slot=line-comment-v2-column><div data-slot=line-comment-v2-text></div><div data-slot=line-comment-v2-meta>"),ae=v("<div data-slot=line-comment-v2-tools>"),re=v("<div data-slot=line-comment-v2-mention-list>"),se=v("<div><div data-slot=line-comment-v2-shell><div data-slot=line-comment-v2-field><div data-slot=line-comment-v2-label></div><textarea data-slot=line-comment-v2-textarea class=ui-line-comment-v2-textarea></textarea></div><div data-slot=line-comment-v2-footer><div data-slot=line-comment-v2-footer-meta></div><div data-slot=line-comment-v2-footer-actions>"),ie=v("<span data-slot=line-comment-v2-mention-file>"),le=v("<button type=button data-slot=line-comment-v2-mention-item class=ui-line-comment-v2-mention-item><div data-slot=line-comment-v2-mention-path><span data-slot=line-comment-v2-mention-dir>");function ce(o){return(()=>{var t=ne();return M(t,K(o,{get width(){return o.width??16},get height(){return o.height??16},viewBox:"0 0 16 16",fill:"none",xmlns:"http://www.w3.org/2000/svg",get"aria-hidden"(){return o["aria-hidden"]??"true"}}),!0,!0),t})()}function U(o){const[t,d]=R(o,["comment","selection","actions","class","classList"]);return(()=>{var y=oe(),a=y.firstChild,S=a.firstChild,V=S.firstChild,E=V.nextSibling;return M(y,K(d,{"data-component":"line-comment-v2","data-variant":"display",get classList(){return{...t.classList,[t.class??""]:!!t.class}}}),!1,!0),r(V,()=>t.comment),r(E,()=>t.selection),r(a,c(O,{get when(){return t.actions},children:w=>(()=>{var b=ae();return r(b,w),b})()}),null),y})()}function me(o){const t=Math.max(o.lastIndexOf("/"),o.lastIndexOf("\\"));return t===-1?o:o.slice(t+1)}function ue(o){const t=Math.max(o.lastIndexOf("/"),o.lastIndexOf("\\"));return t===-1?"":o.slice(0,t+1)}function T(o){let t;const[d,y]=H(!1),[a,S]=R(o,["heading","value","onInput","onCancel","onSubmit","selection","placeholder","rows","cancelLabel","submitLabel","autofocus","mention","class","classList"]),V=()=>a.heading??"Comment",E=()=>a.value.trim().length>0,w=()=>{y(!1),m.clear()},b=()=>{const n=t;if(!n||!a.mention||n.selectionStart!==n.selectionEnd)return;const i=n.selectionStart,s=n.value.slice(0,i).match(/@(\S*)$/);if(s)return{query:s[1]??"",start:i-s[0].length,end:i}};function k(n){if(!n)return;const i=t,s=b();if(!i||!s)return;const x=`${i.value.slice(0,s.start)}@${n.path} ${i.value.slice(s.end)}`,u=s.start+n.path.length+2;a.onInput(x),w(),requestAnimationFrame(()=>{i.focus(),i.setSelectionRange(u,u)})}const m=te({items:async n=>a.mention?n.trim()?(await a.mention.items(n)).map(s=>({path:s})):[]:[],key:n=>n.path,filterKeys:["path"],skipFilter:()=>!0,onSelect:k}),I=()=>{const n=b();if(!n){w();return}y(!0),m.onInput(n.query)},Z=()=>{const n=m.flat();if(n.length===0)return;const i=m.active();k(n.find(s=>s.path===i)??n[0])},W=()=>{const n=a.value.trim();n&&a.onSubmit(n)};return J(()=>{a.autofocus!==!1&&requestAnimationFrame(()=>t?.focus())}),(()=>{var n=se(),i=n.firstChild,s=i.firstChild,x=s.firstChild,u=x.nextSibling,N=s.nextSibling,q=N.firstChild,B=q.nextSibling;return M(n,K(S,{"data-component":"line-comment-v2","data-variant":"editor",get classList(){return{...a.classList,[a.class??""]:!!a.class}}}),!1,!0),r(x,V),u.$$keydown=e=>{if(e.stopPropagation(),!(e.isComposing||e.keyCode===229)){if(d()){if(e.key==="Escape"){e.preventDefault(),w();return}if(e.key==="Tab"){if(m.flat().length===0)return;e.preventDefault(),Z();return}const l=e.key==="ArrowUp"||e.key==="ArrowDown"||e.key==="Enter",$=e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&(e.key==="n"||e.key==="p");if((l||$)&&m.flat().length>0){m.onKeyDown(e),e.preventDefault();return}}if(e.key==="Escape"){e.preventDefault(),e.currentTarget.blur(),a.onCancel();return}e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),W())}},u.addEventListener("select",()=>I()),u.$$click=()=>I(),u.$$input=e=>{a.onInput(e.currentTarget.value),I()},Q(e=>{t=e},u),r(s,c(O,{get when(){return Y(()=>!!d())()&&m.flat().length>0},get children(){var e=re();return r(e,c(X,{get each(){return m.flat().slice(0,10)},children:l=>{const $=l.path.endsWith("/")?l.path:ue(l.path),z=l.path.endsWith("/")?"":me(l.path);return(()=>{var C=le(),D=C.firstChild,j=D.firstChild;return C.$$click=()=>k(l),C.addEventListener("mouseenter",()=>m.setActive(l.path)),C.$$mousedown=_=>_.preventDefault(),r(C,c(ee,{get node(){return{path:l.path,type:"file"}},class:"shrink-0 size-4"}),D),r(j,$),r(D,c(O,{when:z,get children(){var _=ie();return r(_,z),_}}),null),F(()=>A(C,"data-active",m.active()===l.path?"":void 0)),C})()}})),e}}),null),r(q,()=>a.selection),r(B,c(P,{type:"button",size:"normal",variant:"neutral",onClick:()=>a.onCancel(),get children(){return a.cancelLabel??"Cancel"}}),null),r(B,c(P,{type:"button",size:"normal",variant:"contrast",get disabled(){return!E()},onClick:W,get children(){return a.submitLabel??"Comment"}}),null),F(e=>{var l=a.rows??3,$=a.placeholder??"Add context for this change";return l!==e.e&&A(u,"rows",e.e=l),$!==e.t&&A(u,"placeholder",e.t=$),e},{e:void 0,t:void 0}),F(()=>u.value=a.value),n})()}G(["input","click","keydown","mousedown"]);var L=v("<div style=width:400px>"),de=v('<button type=button data-slot=line-comment-v2-overflow aria-label="Comment actions">');const ve='### Overview\nLine comment **display** and **editor** cards aligned with OpenCode line-comment specs (raised `#FAFAFA` surface, footer line context, `ButtonV2` neutral + contrast actions).\n\n### Display\n- `LineCommentV2`: column stack (body + meta) beside optional `actions` (overflow).\n- Use `LineCommentV2OverflowIcon` inside a `data-slot="line-comment-v2-overflow"` button for the Figma dots control.\n\n### Editor\n- `LineCommentEditorV2`: optional `heading` above the textarea (default “Comment”), footer (selection meta + Cancel / Comment).\n- `Enter` submits (Shift+Enter newline); `Escape` cancels. Controlled via `value` / `onInput`.\n',Ve={title:"UI V2/LineComment",id:"components-line-comment-v2",component:U,tags:["autodocs"],parameters:{docs:{description:{component:ve}}}},p={render:()=>(()=>{var o=L();return r(o,c(U,{comment:"Consider guarding against empty arrays.",selection:"Comment on line 40",get actions(){return(()=>{var t=de();return r(t,c(ce,{})),t})()}})),o})()},f={render:()=>(()=>{var o=L();return r(o,c(U,{comment:"Consider guarding against empty arrays.",selection:"Comment on line 40"})),o})()},h={render:()=>{const[o,t]=H("");return(()=>{var d=L();return r(d,c(T,{get value(){return o()},onInput:t,onCancel:()=>t(""),onSubmit:()=>t(""),selection:"Comment on line 40"})),d})()}},g={render:()=>{const[o,t]=H("Use a sentinel or early return when the list is empty.");return(()=>{var d=L();return r(d,c(T,{get value(){return o()},onInput:t,onCancel:()=>t(""),onSubmit:()=>{},selection:"Comment on line 40",autofocus:!1})),d})()}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{code:`const Display = () => (
  <div style={{ width: "400px" }}>
    <LineCommentV2
      comment="Consider guarding against empty arrays."
      selection="Comment on line 40"
      actions={
        <button
          type="button"
          data-slot="line-comment-v2-overflow"
          aria-label="Comment actions"
        >
          <LineCommentV2OverflowIcon />
        </button>
      }
    />
  </div>
);
`,...p.parameters?.docs?.source}}};f.parameters={...f.parameters,docs:{...f.parameters?.docs,source:{code:`const DisplayWithoutActions = () => (
  <div style={{ width: "400px" }}>
    <LineCommentV2
      comment="Consider guarding against empty arrays."
      selection="Comment on line 40"
    />
  </div>
);
`,...f.parameters?.docs?.source}}};h.parameters={...h.parameters,docs:{...h.parameters?.docs,source:{code:`const Editor = () => {
  const [value, setValue] = createSignal("");
  return (
    <div style={{ width: "400px" }}>
      <LineCommentEditorV2
        value={value()}
        onInput={setValue}
        onCancel={() => setValue("")}
        onSubmit={() => setValue("")}
        selection="Comment on line 40"
      />
    </div>
  );
};
`,...h.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{code:`const EditorFilled = () => {
  const [value, setValue] = createSignal(
    "Use a sentinel or early return when the list is empty.",
  );
  return (
    <div style={{ width: "400px" }}>
      <LineCommentEditorV2
        value={value()}
        onInput={setValue}
        onCancel={() => setValue("")}
        onSubmit={() => {}}
        selection="Comment on line 40"
        autofocus={false}
      />
    </div>
  );
};
`,...g.parameters?.docs?.source}}};p.parameters={...p.parameters,docs:{...p.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "400px"
  }}>
      <LineCommentV2 comment="Consider guarding against empty arrays." selection="Comment on line 40" actions={<button type="button" data-slot="line-comment-v2-overflow" aria-label="Comment actions">
            <LineCommentV2OverflowIcon />
          </button>} />
    </div>
}`,...p.parameters?.docs?.source}}};f.parameters={...f.parameters,docs:{...f.parameters?.docs,source:{originalSource:`{
  render: () => <div style={{
    width: "400px"
  }}>
      <LineCommentV2 comment="Consider guarding against empty arrays." selection="Comment on line 40" />
    </div>
}`,...f.parameters?.docs?.source}}};h.parameters={...h.parameters,docs:{...h.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("");
    return <div style={{
      width: "400px"
    }}>
        <LineCommentEditorV2 value={value()} onInput={setValue} onCancel={() => setValue("")} onSubmit={() => setValue("")} selection="Comment on line 40" />
      </div>;
  }
}`,...h.parameters?.docs?.source}}};g.parameters={...g.parameters,docs:{...g.parameters?.docs,source:{originalSource:`{
  render: () => {
    const [value, setValue] = createSignal("Use a sentinel or early return when the list is empty.");
    return <div style={{
      width: "400px"
    }}>
        <LineCommentEditorV2 value={value()} onInput={setValue} onCancel={() => setValue("")} onSubmit={() => {}} selection="Comment on line 40" autofocus={false} />
      </div>;
  }
}`,...g.parameters?.docs?.source}}};const xe=["Display","DisplayWithoutActions","Editor","EditorFilled"];export{p as Display,f as DisplayWithoutActions,h as Editor,g as EditorFilled,xe as __namedExportsOrder,Ve as default};
