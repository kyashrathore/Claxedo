#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")

if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true })
fs.mkdirSync(dist, { recursive: true })

execFileSync(
  path.join(root, "node_modules/.bin/esbuild"),
  [
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--main-fields=module,main",
    "--external:@claxedo/workspace-runtime",
    `--outfile=${path.join(dist, "index.mjs")}`,
    "--banner:js=#!/usr/bin/env node\nimport {createRequire as __cr} from 'module';var require=__cr(import.meta.url);",
  ],
  { cwd: root, stdio: "inherit" },
)

fs.chmodSync(path.join(dist, "index.mjs"), 0o755)
