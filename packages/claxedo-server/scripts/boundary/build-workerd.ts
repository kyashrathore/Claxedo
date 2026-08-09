import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import {
  normalizeEsbuildBuildManifest,
  serializeBuildManifest,
  type EsbuildMetafile,
} from "../../../../script/product-boundary/normalize-build-manifest"

const ROOT = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(ROOT, "../..")
const ENTRY = path.join(ROOT, "src/deployments/hosted-workerd/worker.ts")
const DIST = path.join(ROOT, "dist-worker")
const META = path.join(DIST, "meta.json")

fs.rmSync(DIST, { recursive: true, force: true })
const wrangler = path.join(ROOT, "node_modules/.bin/wrangler")
const result = spawnSync(wrangler, [
  "deploy",
  "--env", "staging",
  "--dry-run",
  "--outdir", "dist-worker",
  "--metafile", "dist-worker/meta.json",
], { cwd: ROOT, env: process.env, stdio: "inherit" })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 2)

const metafile = JSON.parse(fs.readFileSync(META, "utf8")) as EsbuildMetafile
const manifest = normalizeEsbuildBuildManifest({
  entry: ENTRY,
  metafile,
  workingDirectory: ROOT,
  workspaceRoot: REPO_ROOT,
})
const manifestFile = path.join(ROOT, ".artifacts/u8-package-split/manifests/server-workerd.json")
fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
fs.writeFileSync(manifestFile, serializeBuildManifest(manifest))

console.log(`[server-workerd] built ${manifest.modules.length} modules in ${manifest.chunks.length} chunk`)
