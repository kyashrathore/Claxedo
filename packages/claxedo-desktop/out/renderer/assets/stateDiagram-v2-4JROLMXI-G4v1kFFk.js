import { s as styles_default, c as stateRenderer_v3_unified_default, a as stateDb_default, b as stateDiagram_default } from "./chunk-7U56Z5CX-C7Igo0HL.js";
import { _ as __name } from "./mermaid-classDiagram-DWBVSOg0.js";
var diagram = {
  parser: stateDiagram_default,
  db: stateDb_default,
  renderer: stateRenderer_v3_unified_default,
  styles: styles_default,
  init: /* @__PURE__ */ __name((cnf) => {
    if (!cnf.state) {
      cnf.state = {};
    }
    cnf.state.arrowMarkerAbsolute = cnf.arrowMarkerAbsolute;
    stateDb_default.clear();
  }, "init")
};
export {
  diagram
};
