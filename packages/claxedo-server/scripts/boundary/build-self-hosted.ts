import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

import { build } from "esbuild"

import {
  normalizeEsbuildBuildManifest,
  serializeBuildManifest,
} from "../../../../script/product-boundary/normalize-build-manifest"

const ROOT = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(ROOT, "../..")
const ENTRY = path.join(ROOT, "src/deployments/self-hosted-node/index.ts")
const DIST = path.join(ROOT, "dist-boundary/self-hosted")
const OUTFILE = path.join(DIST, "index.js")
const require = createRequire(import.meta.url)

fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(DIST, { recursive: true })
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "external",
  metafile: true,
  mainFields: ["module", "main"],
  conditions: ["node", "development", "import", "default"],
  loader: { ".sh": "text", ".txt": "text" },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; var require = __createRequire(import.meta.url);",
  },
  external: [
    "@cursor/sdk",
    "@cursor/sdk/*",
    "@lydell/node-pty",
    "@opencode-ai/sdk",
    "@opencode-ai/sdk/*",
    "better-sqlite3",
    // The embedded engine is an independently built native-bearing resource.
    // Keeping its public port external preserves that resource boundary while
    // the smoke below proves the exact artifact loads beside this process.
    "opencode/node-embed",
  ],
})

const journalModule = require.resolve("@claxedo/server-core/platform/db/journal")
const migrations = path.join(path.dirname(journalModule), "claxedo-migration")
if (!fs.existsSync(migrations)) throw new Error(`self-hosted migration journal is missing: ${migrations}`)
fs.cpSync(migrations, path.join(DIST, "claxedo-migration"), { recursive: true })

const manifest = normalizeEsbuildBuildManifest({
  entry: ENTRY,
  metafile: result.metafile,
  workingDirectory: ROOT,
  workspaceRoot: REPO_ROOT,
})
const manifestFile = path.join(ROOT, ".artifacts/u8-package-split/manifests/server-self-hosted.json")
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))

console.log(`[server-self-hosted] built ${manifest.modules.length} modules in ${manifest.chunks.length} chunk`)
