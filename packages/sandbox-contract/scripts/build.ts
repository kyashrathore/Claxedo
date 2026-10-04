import path from "node:path"

import { buildPackage } from "../../../script/bun-build"

// The contract is imported by browser, Node and workerd consumers alike, so it
// builds for `browser`: a Node builtin reaching it fails the build.
await buildPackage({
  root: path.resolve(import.meta.dirname, ".."),
  bundles: [{ entrypoints: ["src/index.ts"], target: "browser", format: "esm", naming: "[name].mjs" }],
})
