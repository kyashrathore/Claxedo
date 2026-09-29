import path from "node:path"

import { buildPackage } from "../../../script/bun-build"

await buildPackage({
  root: path.resolve(import.meta.dirname, ".."),
  bundles: [{ entrypoints: ["src/index.ts"], target: "node", format: "esm", packages: "external", naming: "[name].mjs" }],
})
