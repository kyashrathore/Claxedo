import fs from "node:fs"
import path from "node:path"

import { buildPackage } from "../../../script/bun-build"

const ROOT = path.resolve(import.meta.dirname, "..")

await buildPackage({
  root: ROOT,
  bundles: [{ entrypoints: ["src/index.ts"], target: "node", format: "esm", packages: "external", naming: "[name].mjs" }],
})

// The bundle inlines the vendored arctic OAuth client (MIT); its license
// notice must ship with every published copy.
fs.mkdirSync(path.join(ROOT, "dist/vendor/arctic"), { recursive: true })
fs.copyFileSync(
  path.join(ROOT, "src/vendor/arctic/LICENSE-NOTICE.md"),
  path.join(ROOT, "dist/vendor/arctic/LICENSE-NOTICE.md"),
)
