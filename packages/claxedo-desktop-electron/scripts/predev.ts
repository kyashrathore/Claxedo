#!/usr/bin/env bun
/**
 * Pre-dev script for Claxedo Electron desktop app.
 *
 * Builds the patched OpenCode sidecar and copies icons.
 */

import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const CLAXEDO_APP_DIR = path.resolve(PACKAGE_DIR, "../claxedo-app")

// Copy icons
const channel = resolveChannel()
const iconSrc = path.resolve(PACKAGE_DIR, `../claxedo-desktop/icons/${channel}`)
const iconDest = path.resolve(PACKAGE_DIR, "resources/icons")

if (fs.existsSync(iconSrc)) {
  await $`rm -rf ${iconDest}`
  await $`cp -R ${iconSrc} ${iconDest}`
  console.log(`Copied ${channel} icons from ${iconSrc} to ${iconDest}`)
} else {
  console.warn(`[predev] Icons dir not found at ${iconSrc}, skipping icon copy`)
}

// Build patched opencode sidecar
const sidecarConfig = getCurrentSidecar()
const binaryPath = windowsify(
  path.resolve(CLAXEDO_APP_DIR, `dist-opencode/${sidecarConfig.ocBinary}/bin/opencode`),
)

console.log(`[predev] Building patched OpenCode sidecar...`)
await $`bun run ./scripts/build-opencode.ts --single`.cwd(CLAXEDO_APP_DIR)

await copyBinaryToSidecarFolder(binaryPath)

// Bundle claxedo-mcp as JS (no --compile, uses opencode-cli as runtime via BUN_BE_BUN=1)
const mcpSource = path.resolve(CLAXEDO_APP_DIR, "src/opencode-patches/mcp/claxedo-mcp.ts")
const mcpDest = path.resolve(PACKAGE_DIR, "resources/claxedo-mcp.js")

if (fs.existsSync(mcpSource)) {
  console.log(`[predev] Bundling claxedo-mcp JS...`)
  await $`bun build ${mcpSource} --outfile ${mcpDest} --target=bun --minify`
  console.log(`[predev] claxedo-mcp bundled to ${mcpDest}`)
} else {
  console.warn(`[predev] claxedo-mcp source not found at ${mcpSource}, skipping`)
}

console.log(`[predev] Done.`)
