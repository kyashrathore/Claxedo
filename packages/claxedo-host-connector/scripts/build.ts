import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { publishedExportsPlugin } from "../../../script/published-exports-plugin"
import {
  normalizeSourceMapBuildManifest,
  serializeBuildManifest,
  type SourceMapMetadata,
} from "../../../script/product-boundary/normalize-build-manifest"
import { runBunBuild } from "../../../script/bun-build"

const ROOT = path.resolve(import.meta.dirname, "..")
const REPO_ROOT = path.resolve(ROOT, "../..")
const DIST = path.join(ROOT, "dist")
const ENTRY = path.join(ROOT, "src/connector.ts")

fs.rmSync(DIST, { recursive: true, force: true })

const result = await runBunBuild("Host Connector bundle failed", {
  entrypoints: [ENTRY, path.join(ROOT, "src/host-identity.ts")],
  outdir: DIST,
  naming: "[name].mjs",
  format: "esm",
  target: "browser",
  splitting: false,
  sourcemap: "external",
  plugins: [publishedExportsPlugin()],
})

execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
  cwd: ROOT,
  stdio: "inherit",
})

const mapFile = path.join(DIST, "connector.mjs.map")
const sourceMap: SourceMapMetadata = JSON.parse(fs.readFileSync(mapFile, "utf8"))
const manifest = normalizeSourceMapBuildManifest({
  entry: ENTRY,
  sourceMap,
  sourceMapDirectory: DIST,
  chunks: result.outputs
    .filter((output) => output.path.endsWith(".mjs"))
    .map((output) => path.relative(ROOT, output.path)),
  workspaceRoot: REPO_ROOT,
})
const manifestFile = path.join(ROOT, ".artifacts/u8-package-split/manifests/host-connector.json")
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))

console.log(`[host-connector] built ${manifest.modules.length} modules in ${manifest.chunks.length} chunks`)
