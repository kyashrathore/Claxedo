#!/usr/bin/env bun
/**
 * Pre-build script for Claxedo Electron desktop app.
 *
 * Rebuilds and bundles the Claxedo server components,
 * and copies channel-specific icons —
 * so that `bun run build` + `bun run package:mac` produces
 * a fully up-to-date app.
 */

import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"

import { bundleClaxedoServer } from "./bundle-claxedo-server"
import {
  buildClaxedoServerCompileCache,
  resolveElectronBinary,
} from "./build-compile-cache"
import {
  CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME,
} from "../src/shared/compile-cache"
import { bundleHostConnector } from "./bundle-host-connector"
import { buildMemoryImpactHelper } from "./build-memory-impact-helper"
import { LOCAL_SERVER_ENTRY, resolveLocalServerEntry } from "./local-server"
import { prepareRichContentRenderer } from "./build-rich-content-renderer"
import { copyIcons as copyChannelIcons } from "./utils"

// ── Paths ──

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const HELPERS_DIR = path.resolve(PACKAGE_DIR, "../claxedo-helpers")
const EVENT_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../agent-event-runtime")
const AGENT_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../agent-sdk-runtime")
const WS_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../workspace-runtime")
const RUNTIME_CONTRACT_DIR = path.resolve(PACKAGE_DIR, "../agent-runtime-contract")
const EGRESS_BROKER_DIR = path.resolve(PACKAGE_DIR, "../egress-broker")
const RESOURCES_DIR = path.resolve(PACKAGE_DIR, "resources")

const log = (msg: string) => console.log(`[prebuild] ${msg}`)

// ── Icons ──

async function copyIcons() {
  const copied = copyChannelIcons()
  log(`Copied ${copied.channel} icons`)
}

// ── claxedo-server ──

async function bundleServer() {
  // The BOOT stub, not the product entry: it seeds the compile cache and then
  // reaches `claxedo-server-entry.ts` through a dynamic import, so the 9.11 MB
  // closure behind it is compiled after the cache is live. See
  // scripts/claxedo-server-boot.ts.
  const src = path.resolve(SCRIPT_DIR, "claxedo-server-boot.ts")
  const dest = path.resolve(RESOURCES_DIR, "claxedo-server")

  if (!fs.existsSync(src)) {
    throw new Error(`claxedo-server source not found at ${src}`)
  }
  // Resolve the declared local-server entry BEFORE the expensive builds. Bun
  // would report a missing dependency as a bundler log buried under a
  // larger build; this fails in the first second and names the
  // package the desktop cannot start without.
  log(`Local server entry: ${LOCAL_SERVER_ENTRY} → ${resolveLocalServerEntry(PACKAGE_DIR)}`)
  // workspace-runtime imports agent-sdk-runtime through its published `dist`
  // exports. Build that authoritative input first: otherwise a package can
  // contain yesterday's adapter even though today's source and tests are green.
  // The MCP endpoint consumes the helpers' published document and credential
  // subpaths; build these before bundling so a clean checkout has every export.
  log("Building claxedo-helpers...")
  await $`bun run build`.cwd(HELPERS_DIR)
  log("Building agent-event-runtime...")
  await $`bun run build`.cwd(EVENT_RUNTIME_DIR)
  log("Building agent-sdk-runtime...")
  await $`bun run build`.cwd(AGENT_RUNTIME_DIR)
  log("Building workspace-runtime...")
  await $`bun run build`.cwd(WS_RUNTIME_DIR)
  // The local server reaches the egress broker through its published dist, and
  // the broker compiles against the contract's published types.
  log("Building agent-runtime-contract...")
  await $`bun run build`.cwd(RUNTIME_CONTRACT_DIR)
  log("Building egress-broker...")
  await $`bun run build`.cwd(EGRESS_BROKER_DIR)
  log("Bundling claxedo-server...")
  const bundled = await bundleClaxedoServer(src, dest)
  log(`claxedo-server bundled to ${bundled.entry} (${Math.ceil(bundled.outputBytes / 1024 / 1024)} MB split)`)
  // Strictly after the server bundle exists, and generated from the DEFERRED
  // chunk the boot stub imports — entering at index.js would hit the same
  // startup refusal before the dynamic import and cache nothing.
  log("Generating the claxedo-server V8 compile cache...")
  const serverCache = await buildClaxedoServerCompileCache({
    deferredEntryPath: bundled.deferredEntry,
    bundleDir: dest,
    outputDir: path.resolve(RESOURCES_DIR, CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME),
    electronPath: resolveElectronBinary(PACKAGE_DIR),
    log: (message) => log(`server compile cache: ${message}`),
  })
  const serverCacheBytes = serverCache.manifest.entries.reduce((total, entry) => total + entry.bytes, 0)
  log(`server compile cache: ${serverCache.manifest.entries.length} entr(ies), ${serverCacheBytes} bytes`)
}

// ── Main ──

// Optional children, native helpers, and the server are independent build outputs.
await Promise.all([
  copyIcons(),
  bundleServer(),
  bundleHostConnector(),
  buildMemoryImpactHelper(),
  prepareRichContentRenderer({ required: process.env.CLAXEDO_REQUIRE_NATIVE_RICH_CONTENT === "1" }),
])

log("Done.")
