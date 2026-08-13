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
const ENTRY = path.join(ROOT, "src/deployments/hosted-node/index.ts")
const DIST = path.join(ROOT, "dist-boundary/hosted-node")
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
  conditions: ["node", "import", "default"],
  loader: { ".sh": "text", ".txt": "text" },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; var require = __createRequire(import.meta.url);",
  },
  // Keep the optional agent-harness adapters behind the same runtime boundary
  // as @claxedo/agent-sdk-runtime's own build. Re-bundling those SDKs here
  // makes the hosted control plane depend on every optional harness (and, for
  // Cursor, Bun-only implementation files) even though health/control-plane
  // startup never selects one.
  external: [
    "@cursor/sdk",
    "@cursor/sdk/*",
    "@lydell/node-pty",
    "@opencode-ai/sdk",
    "@opencode-ai/sdk/*",
    "better-sqlite3",
    // The server-core transport owns a deliberately lazy embedded-engine
    // loader. Hosted Node supplies hosted services and never selects it; keep
    // that import lazy instead of folding the local OpenCode/PTY runtime into
    // the cloud process at build time.
    "opencode/node-embed",
  ],
})

const journalModule = require.resolve("@claxedo/server-core/platform/db/journal")
const migrations = path.join(path.dirname(journalModule), "claxedo-migration")
if (!fs.existsSync(migrations)) throw new Error(`hosted Node migration journal is missing: ${migrations}`)
fs.cpSync(migrations, path.join(DIST, "claxedo-migration"), { recursive: true })

const manifest = normalizeEsbuildBuildManifest({
  entry: ENTRY,
  metafile: result.metafile,
  workingDirectory: ROOT,
  workspaceRoot: REPO_ROOT,
})
const manifestFile = path.join(ROOT, ".artifacts/u8-package-split/manifests/server-cloud-node.json")
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))

console.log(`[server-cloud-node] built ${manifest.modules.length} modules in ${manifest.chunks.length} chunk`)
