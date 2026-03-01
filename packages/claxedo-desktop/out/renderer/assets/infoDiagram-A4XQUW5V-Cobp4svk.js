import { s as selectSvgElement, v as version } from "./mermaid.core-CJBzxvbd.js";
import { _ as __name, l as log, e as configureSvgSize } from "./mermaid-classDiagram-DWBVSOg0.js";
import { p as parse } from "./gitGraph-YCYPL57B-BSbiBER8.js";
import "./min-WV6PocAF.js";
import "./_baseUniq-N-cIHQzH.js";
var parser = {
  parse: /* @__PURE__ */ __name(async (input) => {
    const ast = await parse("info", input);
    log.debug(ast);
  }, "parse")
};
var DEFAULT_INFO_DB = { version };
var getVersion = /* @__PURE__ */ __name(() => DEFAULT_INFO_DB.version, "getVersion");
var db = {
  getVersion
};
var draw = /* @__PURE__ */ __name((text, id, version2) => {
  log.debug("rendering info diagram\n" + text);
  const svg = selectSvgElement(id);
  configureSvgSize(svg, 100, 400, true);
  const group = svg.append("g");
  group.append("text").attr("x", 100).attr("y", 40).attr("class", "version").attr("font-size", 32).style("text-anchor", "middle").text(`v${version2}`);
}, "draw");
var renderer = { draw };
var diagram = {
  parser,
  db,
  renderer
};
export {
  diagram
};
