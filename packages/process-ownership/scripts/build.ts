import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")
const esbuild = path.join(root, "node_modules/.bin/esbuild")
const tsc = path.join(root, "node_modules/.bin/tsc")

execFileSync(tsc, ["-p", "tsconfig.build.json", "--noEmit", "--emitDeclarationOnly", "false"], { cwd: root, stdio: "inherit" })
if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true })
fs.mkdirSync(dist, { recursive: true })

execFileSync(esbuild, [
  "src/launch/index.ts",
  "src/process-observer.ts",
  "src/process-lifecycle.ts",
  "src/windows-process.ts",
  "src/spawn-env.ts",
  "--bundle", "--platform=node", "--format=esm", "--splitting", "--target=node22",
  "--outdir=dist", "--outbase=src", "--out-extension:.js=.mjs",
  "--chunk-names=chunks/[name]-[hash]",
  "--external:@claxedo/helpers", "--external:@claxedo/helpers/*",
  "--external:@claxedo/agent-runtime-contract", "--external:@claxedo/agent-runtime-contract/*",
], { cwd: root, stdio: "inherit" })

// The gate child is copied beside standalone hosts without node_modules or
// shared chunks, so every dependency must be bundled into this one file.
execFileSync(esbuild, [
  "src/launch/launch-gate-child.ts",
  "--bundle", "--platform=node", "--format=esm", "--target=node22",
  "--outfile=dist/launch-gate-child.mjs",
], { cwd: root, stdio: "inherit" })
execFileSync(tsc, ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" })
