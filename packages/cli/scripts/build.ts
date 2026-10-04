import fs from "node:fs"
import path from "node:path"

import { buildPackage } from "../../../script/bun-build"

const ROOT = path.resolve(import.meta.dirname, "..")

await buildPackage({
  root: ROOT,
  declarations: false,
  bundles: [{
    entrypoints: ["src/index.ts"],
    target: "node",
    format: "esm",
    naming: "[name].mjs",
    external: ["@claxedo/workspace-runtime", "better-sqlite3"],
    banner: "#!/usr/bin/env node",
  }],
})

fs.chmodSync(path.join(ROOT, "dist/index.mjs"), 0o755)
