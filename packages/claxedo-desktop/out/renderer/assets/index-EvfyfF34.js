import { d4 as Editor } from "./main-CfU7H2cy.js";
import { b as createSignal, g as createEffect, h as onCleanup } from "./styles-BYu1h1zk.js";
import "./mermaid-classDiagram-DWBVSOg0.js";
function d(t, e) {
  let [o, i] = createSignal(void 0, { equals: false });
  function n() {
    i();
  }
  return createEffect(() => {
    let u = t();
    u && (u.on("transaction", n), onCleanup(() => {
      u.off("transaction", n);
    }));
  }), () => (o(), e(t()));
}
function r(t) {
  let [e, o] = createSignal();
  return createEffect(() => {
    let i = new Editor({ ...t() });
    onCleanup(() => {
      i.destroy();
    }), o(i);
  }), e;
}
function l(t) {
  return d(t, (e) => e == null ? void 0 : e.getHTML());
}
function x(t) {
  return d(t, (e) => e == null ? void 0 : e.getJSON());
}
function a(t, ...e) {
  return d(t, (o) => e.length === 2 ? o == null ? void 0 : o.isActive(e[0](), e[1]) : o == null ? void 0 : o.isActive(e[0]));
}
function m(t) {
  return d(t, (e) => e == null ? void 0 : e.isEmpty);
}
function T(t) {
  return d(t, (e) => e == null ? void 0 : e.isEditable);
}
function V(t) {
  return d(t, (e) => e == null ? void 0 : e.isFocused);
}
export {
  r as createEditor,
  d as createEditorTransaction,
  r as createTiptapEditor,
  r as useEditor,
  l as useEditorHTML,
  a as useEditorIsActive,
  T as useEditorIsEditable,
  m as useEditorIsEmpty,
  V as useEditorIsFocused,
  x as useEditorJSON,
  r as useTiptapEditor
};
