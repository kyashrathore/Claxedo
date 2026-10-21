import fs from "node:fs"
import path from "node:path"

import { CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/journal"
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

// The bundle resolves the journal beside itself (`import.meta.dirname` of
// dist/index.mjs), and `claxedo connect` refuses every workspace without it.
if (!fs.existsSync(CLAXEDO_MIGRATION_JOURNAL)) throw new Error(`claxedo migration journal is missing: ${CLAXEDO_MIGRATION_JOURNAL}`)
fs.cpSync(CLAXEDO_MIGRATION_JOURNAL, path.join(ROOT, "dist", "claxedo-migration"), { recursive: true })
