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
const CLAXEDO_SERVER_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server")
const OPENCODE_DIR = path.resolve(PACKAGE_DIR, "../opencode")

// Copy icons
const channel = resolveChannel()
const iconSrc = path.resolve(PACKAGE_DIR, `icons/${channel}`)
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
const binaryPath = windowsify(path.resolve(OPENCODE_DIR, `dist/${sidecarConfig.ocBinary}/bin/opencode`))
const existingBinary = windowsify(path.resolve(PACKAGE_DIR, "resources/opencode-cli"))
const models = Bun.env.MODELS_DEV_API_JSON ?? path.join("test", "tool", "fixtures", "models-api.json")

console.log(`[predev] Building patched OpenCode sidecar...`)
try {
  await (sidecarConfig.ocBinary.includes("-baseline")
    ? $`bun run build --single --baseline --skip-install`
    : $`bun run build --single --skip-install`
  ).cwd(OPENCODE_DIR).env({
    ...Bun.env,
    MODELS_DEV_API_JSON: models,
  })

  await copyBinaryToSidecarFolder(binaryPath)
} catch (e) {
  if (fs.existsSync(existingBinary)) {
    console.warn(`[predev] Sidecar build failed, using existing binary from resources/opencode-cli`)
  } else {
    throw e
  }
}

// Bundle claxedo-mcp as Node-compatible JS for local desktop resources
const mcpSource = path.resolve(CLAXEDO_SERVER_DIR, "src/mcp/claxedo-mcp.ts")
const mcpDest = path.resolve(PACKAGE_DIR, "resources/claxedo-mcp.js")

if (fs.existsSync(mcpSource)) {
  console.log(`[predev] Bundling claxedo-mcp JS...`)
  await $`bun build ${mcpSource} --outfile ${mcpDest} --target=node --minify`
  console.log(`[predev] claxedo-mcp bundled to ${mcpDest}`)
} else {
  console.warn(`[predev] claxedo-mcp source not found at ${mcpSource}, skipping`)
}

console.log(`[predev] Done.`)
