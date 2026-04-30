#!/usr/bin/env node

/**
 * Bundle workspace-runtime into a tarball for upload into Daytona sandboxes.
 *
 * Produces: packages/workspace-runtime-bundle.tar.gz
 *
 * Steps:
 *   1. esbuild: bundle src/main.ts → dist/runtime.mjs (externalize native deps)
 *   2. Copy production node_modules for native deps (better-sqlite3, node-pty)
 *   3. Copy ACP binaries if present
 *   4. Create tarball
 *
 * Usage: npx tsx scripts/bundle.ts
 */

import { execSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist", "bundle-staging")
const OUT_TARBALL = path.resolve(ROOT, "..", "workspace-runtime-bundle.tar.gz")

// Native modules that cannot be bundled by esbuild
const NATIVE_EXTERNALS = [
  "better-sqlite3",
  "node-pty",
  "cpu-features",
  "prebuild-install",
]

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: opts?.cwd ?? ROOT })
}

function clean() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true })
  }
  fs.mkdirSync(DIST, { recursive: true })
}

function bundle() {
  const externals = NATIVE_EXTERNALS.map((m) => `--external:${m}`).join(" ")
  run(
    `npx esbuild src/main.ts --bundle --platform=node --format=esm --outfile=${DIST}/runtime.mjs ${externals} --target=node22 --main-fields=module,main --banner:js="import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);"`,
  )
}

function copyNativeModules() {
  // Install production deps for native modules into the staging directory
  const pkg = {
    name: "workspace-runtime-bundle",
    private: true,
    dependencies: {
      "better-sqlite3": "^11.0.0",
      "node-pty": "^1.0.0",
    },
  }
  fs.writeFileSync(path.join(DIST, "package.json"), JSON.stringify(pkg, null, 2))
  run("npm install --omit=dev", { cwd: DIST })
  // Remove the temporary package.json
  fs.unlinkSync(path.join(DIST, "package.json"))
  // Remove package-lock if created
  const lockfile = path.join(DIST, "package-lock.json")
  if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile)
}

function copyAcpBinaries() {
  // Copy ACP adapter binaries if they exist in node_modules
  const acpDirs = [
    "@zed-industries/claude-agent-acp",
    "@zed-industries/codex-acp",
  ]
  for (const dir of acpDirs) {
    const src = path.join(ROOT, "node_modules", dir)
    if (!fs.existsSync(src)) continue
    const dest = path.join(DIST, "node_modules", dir)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(src, dest, { recursive: true })
    console.log(`Copied ${dir}`)
  }
}

function createTarball() {
  run(`tar czf ${OUT_TARBALL} -C ${DIST} .`)
  const size = fs.statSync(OUT_TARBALL).size
  console.log(`\nBundle created: ${OUT_TARBALL} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

try {
  clean()
  bundle()
  copyNativeModules()
  copyAcpBinaries()
  createTarball()
} catch (err) {
  console.error("Bundle failed:", err)
  process.exit(1)
}
