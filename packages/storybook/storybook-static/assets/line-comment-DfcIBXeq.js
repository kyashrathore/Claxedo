import{s as K,b as p,m as q,i as r,K as b,t as f,S as x,aa as W,aN as c,W as F,L as g,ab as j,c as N,o as R,ad as G,V as U,x as Z}from"./iframe-D288tw9h.js";import{g as J,a as Q}from"./path-E3n8mp_5.js";import{B}from"./button-Bsz0PTzb.js";import{F as X}from"./file-icon-CrT71WKR.js";import{I as Y}from"./icon-BG5j3Qjr.js";import{u as V}from"./i18n-CW9P7x91.js";import{u as tt}from"./use-filtered-list-XOqX6bHa.js";const et=`
[data-annotation-slot] {
  padding: 12px;
  box-sizing: border-box;
}

[data-component="line-comment"] {
  position: absolute;
  right: 24px;
  z-index: var(--line-comment-z, 30);
}

[data-component="line-comment"][data-inline] {
  position: relative;
  right: auto;
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: flex-start;
}

[data-component="line-comment"][data-open] {
  z-index: var(--line-comment-open-z, 100);
}

[data-component="line-comment"] [data-slot="line-comment-button"] {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--icon-interactive-base);
  box-shadow: var(--shadow-xs);
  cursor: default;
  border: none;
}

[data-component="line-comment"][data-variant="add"] [data-slot="line-comment-button"] {
  background: var(--syntax-diff-add);
}

[data-component="line-comment"] [data-component="icon"] {
  color: var(--icon-on-interactive-base);
}

[data-component="line-comment"] [data-slot="line-comment-icon"] {
  width: 12px;
  height: 12px;
  color: var(--icon-on-interactive-base);
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus {
  outline: none;
}

[data-component="line-comment"] [data-slot="line-comment-button"]:focus-visible {
  box-shadow: var(--shadow-xs-border-focus);
}

[data-component="line-comment"] [data-slot="line-comment-popover"] {
  position: absolute;
  top: calc(100% + 4px);
  right: -8px;
  z-index: var(--line-comment-popover-z, 40);
  min-width: 200px;
  max-width: none;
  box-sizing: border-box;
  border-radius: var(--radius-lg);
  background: var(--surface-raised-stronger-non-alpha);
  box-shadow: var(--shadow-xxs-border);
  padding: 12px;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"] {
  position: relative;
  top: auto;
  right: auto;
  margin-left: 8px;
  flex: 1 1 0%;
  width: auto;
  max-width: 100%;
  min-width: 0;
}

[data-component="line-comment"][data-inline] [data-slot="line-comment-popover"][data-inline-body] {
  margin-left: 0;
}

[data-component="line-comment"][data-inline][data-variant="default"] [data-slot="line-comment-popover"][data-inline-body] {
  cursor: pointer;
}

[data-component="line-comment"][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 380px;
  max-width: none;
  padding: 8px;
  border-radius: var(--radius-3xl);
}

[data-component="line-comment"][data-inline][data-variant="editor"] [data-slot="line-comment-popover"] {
  width: 100%;
}

[data-component="line-comment"] [data-slot="line-comment-content"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-head"] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-text"] {
  flex: 1;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-regular);
  line-height: var(--line-height-x-large);
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-tools"] {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-label"],
[data-component="line-comment"] [data-slot="line-comment-editor-label"] {
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
  line-height: var(--line-height-large);
  letter-spacing: var(--letter-spacing-normal);
  color: var(--text-weak);
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

[data-component="line-comment"] [data-slot="line-comment-editor"] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-textarea"] {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 8px;
  border-radius: var(--radius-md);
  background: var(--surface-base);
  border: 1px solid var(--border-base);
  color: var(--text-strong);
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  line-height: var(--line-height-large);
}

[data-component="line-comment"] [data-slot="line-comment-textarea"]:focus {
  outline: none;
  box-shadow: var(--shadow-xs-border-select);
}

[data-component="line-comment"] [data-slot="line-comment-mention-list"] {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--border-base);
  border-radius: var(--radius-md);
  background: var(--surface-base);
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-strong);
  text-align: left;
}

[data-component="line-comment"] [data-slot="line-comment-mention-item"][data-active] {
  background: var(--surface-raised-base-hover);
}

[data-component="line-comment"] [data-slot="line-comment-mention-path"] {
  display: flex;
  align-items: center;
  min-width: 0;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  line-height: var(--line-height-large);
}

[data-component="line-comment"] [data-slot="line-comment-mention-dir"] {
  min-width: 0;
  color: var(--text-weak);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-component="line-comment"] [data-slot="line-comment-mention-file"] {
  color: var(--text-strong);
  white-space: nowrap;
}

[data-component="line-comment"] [data-slot="line-comment-actions"] {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 8px;
  min-width: 0;
}

[data-component="line-comment"] [data-slot="line-comment-editor-label"] {
  flex: 1 1 220px;
  margin-right: auto;
}

[data-component="line-comment"] [data-slot="line-comment-action"] {
  border: 1px solid var(--border-base);
  background: var(--surface-base);
  color: var(--text-strong);
  border-radius: var(--radius-md);
  height: 28px;
  padding: 0 10px;
  font-family: var(--font-family-sans);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="ghost"] {
  background: transparent;
}

[data-component="line-comment"] [data-slot="line-comment-action"][data-variant="primary"] {
  background: var(--text-strong);
  border-color: var(--text-strong);
  color: var(--background-base);
}

[data-component="line-comment"] [data-slot="line-comment-action"]:disabled {
  opacity: 0.5;
  pointer-events: none;
}
`;let I=!1;function nt(){if(I||typeof document>"u")return;const t="opencode-line-comment-styles";if(document.getElementById(t)){I=!0;return}const s=document.createElement("style");s.id=t,s.textContent=et,document.head.appendChild(s),I=!0}var at=f('<svg><path d="M16.25 3.75H3.75V16.25L6.875 14.4643H16.25V3.75Z"stroke=currentColor stroke-linecap=square></svg>',!1,!0,!1),ot=f('<svg data-slot=line-comment-icon viewBox="0 0 20 20"fill=none aria-hidden=true>'),it=f('<svg><path d="M10 5.41699V10.0003M10 10.0003V14.5837M10 10.0003H5.4165M10 10.0003H14.5832"stroke=currentColor stroke-linecap=square></svg>',!1,!0,!1),lt=f("<div data-slot=line-comment-popover data-inline-body>"),rt=f("<div data-component=line-comment data-prevent-autofocus>"),mt=f("<button type=button data-slot=line-comment-button>"),st=f("<div data-slot=line-comment-popover>"),ct=f("<div data-slot=line-comment-tools>"),dt=f("<div data-slot=line-comment-content><div data-slot=line-comment-head><div data-slot=line-comment-text></div></div><div data-slot=line-comment-label>"),ut=f("<div data-slot=line-comment-mention-list>"),pt=f("<div data-slot=line-comment-editor><textarea data-slot=line-comment-textarea></textarea><div data-slot=line-comment-actions><div data-slot=line-comment-editor-label>"),vt=f("<span data-slot=line-comment-mention-file>"),ft=f("<button type=button data-slot=line-comment-mention-item><div data-slot=line-comment-mention-path><span data-slot=line-comment-mention-dir>"),ht=f("<button type=button data-slot=line-comment-action data-variant=ghost>"),gt=f("<button type=button data-slot=line-comment-action data-variant=primary>");nt();function bt(t){return(()=>{var s=ot();return r(s,p(x,{get when(){return t.icon==="comment"},get fallback(){return it()},get children(){return at()}})),s})()}const H=t=>{const s=()=>!t.inline&&t.top===void 0,o=()=>t.variant??"default",y=()=>t.icon??"comment",h=()=>t.inline&&t.hideButton;return(()=>{var v=rt();return r(v,p(x,{get when(){return h()},get fallback(){return[(()=>{var e=mt();return c(e,"mouseenter",t.onMouseEnter),c(e,"click",t.onClick),c(e,"mouseup",m=>m.stopPropagation()),c(e,"mousedown",m=>m.stopPropagation()),r(e,p(x,{get when(){return t.inline},get fallback(){return p(Y,{get name(){return y()==="plus"?"plus-small":"comment"},size:"small"})},get children(){return p(bt,{get icon(){return y()}})}})),b(()=>g(e,"aria-label",t.buttonLabel)),e})(),p(x,{get when(){return t.open},get children(){var e=st();return c(e,"focusout",t.onPopoverFocusOut),c(e,"mousedown",m=>m.stopPropagation()),r(e,()=>t.children),b(m=>F(e,{[t.popoverClass??""]:!!t.popoverClass},m)),e}})]},get children(){var e=lt();return c(e,"focusout",t.onPopoverFocusOut),c(e,"mouseenter",t.onMouseEnter),c(e,"click",t.onClick),c(e,"mousedown",m=>m.stopPropagation()),r(e,()=>t.children),b(m=>F(e,{[t.popoverClass??""]:!!t.popoverClass},m)),e}})),b(e=>{var m=o(),d=t.id,C=t.open?"":void 0,$=t.inline?"":void 0,L={[t.class??""]:!!t.class},_=t.inline?void 0:{top:`${t.top??0}px`,opacity:s()?0:1,"pointer-events":s()?"none":"auto"};return m!==e.e&&g(v,"data-variant",e.e=m),d!==e.t&&g(v,"data-comment-id",e.t=d),C!==e.a&&g(v,"data-open",e.a=C),$!==e.o&&g(v,"data-inline",e.o=$),e.i=F(v,L,e.i),e.n=j(v,_,e.n),e},{e:void 0,t:void 0,a:void 0,o:void 0,i:void 0,n:void 0}),v})()},zt=t=>{const s=V(),[o,y]=K(t,["comment","selection","actions"]);return p(H,q(y,{variant:"default",get hideButton(){return t.inline},get children(){var h=dt(),v=h.firstChild,e=v.firstChild,m=v.nextSibling;return r(e,()=>o.comment),r(v,p(x,{get when(){return o.actions},get children(){var d=ct();return r(d,()=>o.actions),d}}),null),r(m,()=>s.t("ui.lineComment.label.prefix"),null),r(m,()=>o.selection,null),r(m,()=>s.t("ui.lineComment.label.suffix"),null),h}}))},Lt=t=>{const s=V(),[o,y]=K(t,["value","selection","onInput","onCancel","onSubmit","placeholder","rows","autofocus","cancelLabel","submitLabel","mention"]),h={textarea:void 0},[v,e]=N(!1);function m(a){if(!a)return;const l=h.textarea,u=A();if(!l||!u)return;const z=`${l.value.slice(0,u.start)}@${a.path} ${l.value.slice(u.end)}`,n=u.start+a.path.length+2;o.onInput(z),_(),requestAnimationFrame(()=>{l.focus(),l.setSelectionRange(n,n)})}const d=tt({items:async a=>o.mention?a.trim()?(await o.mention.items(a)).map(u=>({path:u})):[]:[],key:a=>a.path,filterKeys:["path"],skipFilter:()=>!0,onSelect:m}),C=()=>h.textarea?.focus(),$=a=>{a.preventDefault(),a.stopPropagation()},L=a=>l=>{l.stopPropagation(),a()},_=()=>{e(!1),d.clear()},A=()=>{const a=h.textarea;if(!a||!o.mention||a.selectionStart!==a.selectionEnd)return;const l=a.selectionStart,u=a.value.slice(0,l).match(/@(\S*)$/);if(u)return{query:u[1]??"",start:l-u[0].length,end:l}},M=()=>{const a=A();if(!a){_();return}e(!0),d.onInput(a.query)},O=()=>{const a=d.flat();if(a.length===0)return;const l=d.active();m(a.find(u=>u.path===l)??a[0])},P=()=>{const a=o.value.trim();a&&o.onSubmit(a)};return R(()=>{o.autofocus!==!1&&requestAnimationFrame(C)}),p(H,q(y,{open:!0,variant:"editor",get hideButton(){return t.inline},onClick:()=>C(),get children(){var a=pt(),l=a.firstChild,u=l.nextSibling,z=u.firstChild;return c(l,"keydown",n=>{const i=n;if(!(i.isComposing||i.keyCode===229)){if(i.stopPropagation(),v()){if(n.key==="Escape"){i.preventDefault(),_();return}if(n.key==="Tab"){if(d.flat().length===0)return;i.preventDefault(),O();return}const k=n.key==="ArrowUp"||n.key==="ArrowDown"||n.key==="Enter",E=i.ctrlKey&&!i.metaKey&&!i.altKey&&!i.shiftKey&&(n.key==="n"||n.key==="p");if((k||E)&&d.flat().length>0){d.onKeyDown(i),i.preventDefault();return}}if(n.key==="Escape"){i.preventDefault(),n.currentTarget.blur(),o.onCancel();return}n.key==="Enter"&&(n.shiftKey||(i.preventDefault(),P()))}}),c(l,"select",()=>M()),c(l,"click",()=>M()),c(l,"input",n=>{const i=n.currentTarget.value;o.onInput(i),M()}),G(n=>{h.textarea=n},l),r(a,p(x,{get when(){return Z(()=>!!v())()&&d.flat().length>0},get children(){var n=ut();return r(n,p(U,{get each(){return d.flat().slice(0,10)},children:i=>{const k=i.path.endsWith("/")?i.path:J(i.path),E=i.path.endsWith("/")?"":Q(i.path);return(()=>{var w=ft(),D=w.firstChild,T=D.firstChild;return w.$$click=()=>m(i),w.addEventListener("mouseenter",()=>d.setActive(i.path)),w.$$mousedown=S=>S.preventDefault(),r(w,p(X,{get node(){return{path:i.path,type:"file"}},class:"shrink-0 size-4"}),D),r(T,k),r(D,p(x,{when:E,get children(){var S=vt();return r(S,E),S}}),null),b(()=>g(w,"data-active",d.active()===i.path?"":void 0)),w})()}})),n}}),u),r(z,()=>s.t("ui.lineComment.editorLabel.prefix"),null),r(z,()=>o.selection,null),r(z,()=>s.t("ui.lineComment.editorLabel.suffix"),null),r(u,p(x,{get when(){return!t.inline},get fallback(){return[(()=>{var n=ht();return c(n,"click",L(o.onCancel)),c(n,"mousedown",$),r(n,()=>o.cancelLabel??s.t("ui.common.cancel")),n})(),(()=>{var n=gt();return c(n,"click",L(P)),c(n,"mousedown",$),r(n,()=>o.submitLabel??s.t("ui.lineComment.submit")),b(()=>n.disabled=o.value.trim().length===0),n})()]},get children(){return[p(B,{size:"small",variant:"ghost",get onClick(){return o.onCancel},get children(){return o.cancelLabel??s.t("ui.common.cancel")}}),p(B,{size:"small",variant:"primary",get disabled(){return o.value.trim().length===0},onClick:P,get children(){return o.submitLabel??s.t("ui.lineComment.submit")}})]}}),null),b(n=>{var i=o.rows??3,k=o.placeholder??s.t("ui.lineComment.placeholder");return i!==n.e&&g(l,"rows",n.e=i),k!==n.t&&g(l,"placeholder",n.t=k),n},{e:void 0,t:void 0}),b(()=>l.value=o.value),a}}))};W(["mousedown","click"]);export{zt as L,Lt as a,H as b};
