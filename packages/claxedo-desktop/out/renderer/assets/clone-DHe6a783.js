import { b as baseClone } from "./graph-DS2E-rdp.js";
var CLONE_SYMBOLS_FLAG = 4;
function clone(value) {
  return baseClone(value, CLONE_SYMBOLS_FLAG);
}
export {
  clone as c
};
