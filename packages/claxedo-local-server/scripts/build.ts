import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

import {
  normalizeSourceMapBuildManifest,
  serializeBuildManifest,
  type SourceMapMetadata,
} from "../../../script/product-boundary/normalize-build-manifest"

const ROOT = path.resolve(import.meta.dirname, "..")
const REPO_ROOT = path.resolve(ROOT, "../..")
const DIST = path.join(ROOT, "dist")
const ENTRY = path.join(ROOT, "src/self-hosted-execution.ts")
const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(path.join(ROOT, "../workspace-runtime/package.json"))

fs.rmSync(DIST, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  naming: { entry: "self-hosted-execution.[ext]" },
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  // Native modules are resources supplied by the composition host.
  external: ["@lydell/node-pty", "better-sqlite3"],
  plugins: [{
    name: "jsonc-parser-esm",
    setup(build) {
      build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
        path: runtimeRequire.resolve("jsonc-parser/lib/esm/main.js"),
      }))
    },
  }],
})
if (!result.success) throw new AggregateError(result.logs, "Local Server bundle failed")

const journalModule = require.resolve("@claxedo/server-core/platform/db/journal")
const migrations = path.join(path.dirname(journalModule), "claxedo-migration")
if (!fs.existsSync(migrations)) throw new Error(`Local Server migration journal is missing: ${migrations}`)
fs.cpSync(migrations, path.join(DIST, "claxedo-migration"), { recursive: true })

const mapFile = path.join(DIST, "self-hosted-execution.js.map")
const sourceMap = JSON.parse(fs.readFileSync(mapFile, "utf8")) as SourceMapMetadata
const manifest = normalizeSourceMapBuildManifest({
  entry: ENTRY,
  sourceMap,
  sourceMapDirectory: DIST,
  chunks: result.outputs
    .filter((output) => output.kind === "entry-point")
    .map((output) => path.relative(ROOT, output.path)),
  workspaceRoot: REPO_ROOT,
})
const manifestFile = path.join(ROOT, ".artifacts/u8-package-split/manifests/local-server.json")
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))

console.log(`[local-server] built ${manifest.modules.length} modules in ${manifest.chunks.length} chunk`)
