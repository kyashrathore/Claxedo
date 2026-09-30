#!/usr/bin/env bun
/**
 * Prepares every artifact the desktop build and dev run consume: channel
 * icons, the local-server bundle and its V8 compile cache, the Host Connector
 * child and the native Mermaid renderer.
 *
 * `prebuild` runs this file and rebuilds everything; `predev` calls
 * {@link prepareDesktopArtifacts} with `staleOnly`, which skips the server
 * bundle and its compile cache while their inputs are older than them.
 */

import * as fs from "node:fs"
import * as path from "node:path"

import { buildPublishedPackages, publishedPackageDistDirs } from "./published-packages"
import { bundleClaxedoServer, resolveDeferredServerEntry } from "./bundle-claxedo-server"
import { buildClaxedoServerCompileCache, resolveElectronBinary } from "./build-compile-cache"
import { bundleHostConnector } from "./bundle-host-connector"
import { prepareMermaidRenderer } from "./build-mermaid-renderer"
import {
  LOCAL_SERVER_ENTRY,
  localServerBootSource,
  localServerBundleEntry,
  localServerPackageDir,
  resolveLocalServerEntry,
} from "./local-server"
import { copyIcons } from "./utils"
import {
  CLAXEDO_COMPILE_CACHE_MANIFEST_NAME,
  CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME,
} from "../src/shared/compile-cache"

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..")

type Log = (message: string) => void

export async function prepareDesktopArtifacts(options: { staleOnly: boolean; log: Log }) {
  const { staleOnly, log } = options
  const icons = copyIcons()
  log(`Copied ${icons.channel} icons from ${icons.src} to ${icons.dest}`)
  // Resolved before the expensive builds: Bun would report a missing
  // dependency as a bundler log buried under a larger build.
  log(`Local server entry: ${LOCAL_SERVER_ENTRY} → ${resolveLocalServerEntry(PACKAGE_DIR)}`)

  const [, hostConnector] = await Promise.all([
    prepareServer(staleOnly, log),
    bundleHostConnector(),
    prepareMermaidRenderer({ required: process.env.CLAXEDO_REQUIRE_NATIVE_MERMAID === "1" }),
  ])
  log(`Host Connector child bundled (${hostConnector.manifest.sha256})`)
}

async function prepareServer(staleOnly: boolean, log: Log) {
  await buildPublishedPackages(REPO_ROOT, log)

  const entry = localServerBundleEntry(PACKAGE_DIR)
  const bundleDir = path.dirname(entry)
  let deferredEntry: string
  if (!staleOnly || outputIsStale(entry, serverBundleInputs())) {
    log("Bundling claxedo-server...")
    const bundled = await bundleClaxedoServer(localServerBootSource(PACKAGE_DIR), bundleDir)
    log(`claxedo-server bundled to ${bundled.entry} (${Math.ceil(bundled.outputBytes / 1024 / 1024)} MB split)`)
    deferredEntry = bundled.deferredEntry
  } else {
    log("claxedo-server bundle is current")
    deferredEntry = resolveDeferredServerEntry(entry)
  }

  // Generated from the DEFERRED chunk the boot stub imports: entering at
  // index.js would hit the startup refusal before the dynamic import and cache
  // nothing. Gated on that chunk, because a chunk whose content hash moved is
  // a source hash V8 rejects.
  const cacheDir = path.join(PACKAGE_DIR, "resources", CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME)
  if (staleOnly && !outputIsStale(path.join(cacheDir, CLAXEDO_COMPILE_CACHE_MANIFEST_NAME), [
    deferredEntry,
    path.join(PACKAGE_DIR, "src/main/server-runtime-policy.ts"),
    path.join(PACKAGE_DIR, "scripts/build-compile-cache.ts"),
    path.join(PACKAGE_DIR, "src/shared/compile-cache.ts"),
  ])) {
    log("claxedo-server V8 compile cache is current")
    return
  }
  log("Generating the claxedo-server V8 compile cache...")
  const cache = await buildClaxedoServerCompileCache({
    deferredEntryPath: deferredEntry,
    bundleDir,
    outputDir: cacheDir,
    electronPath: resolveElectronBinary(PACKAGE_DIR),
    log: (message) => log(`server compile cache: ${message}`),
  })
  const bytes = cache.manifest.entries.reduce((total, item) => total + item.bytes, 0)
  log(`server compile cache: ${cache.manifest.entries.length} entr(ies), ${bytes} bytes`)
}

/** Everything the server bundle is built from, for the `staleOnly` check. */
function serverBundleInputs() {
  return [
    path.join(PACKAGE_DIR, "scripts/bundle-claxedo-server.ts"),
    path.join(PACKAGE_DIR, "src/server"),
    path.join(PACKAGE_DIR, "src/shared"),
    path.join(PACKAGE_DIR, "src/main/server-daemon-discovery.ts"),
    path.join(localServerPackageDir(PACKAGE_DIR), "src"),
    path.join(PACKAGE_DIR, "../claxedo-server-core/src"),
    // Published siblings enter the bundle as their dist, so the dist is what
    // decides staleness, not the source behind it.
    ...publishedPackageDistDirs(REPO_ROOT),
  ]
}

function outputIsStale(output: string, inputs: string[]) {
  if (!fs.existsSync(output)) return true
  const outputTime = fs.statSync(output).mtimeMs
  const pending = inputs.filter((input) => fs.existsSync(input))
  while (pending.length > 0) {
    const input = pending.pop()
    if (!input) continue
    const stat = fs.statSync(input)
    if (stat.mtimeMs > outputTime) return true
    if (!stat.isDirectory()) continue
    pending.push(...fs.readdirSync(input).map((entry) => path.join(input, entry)))
  }
  return false
}

if (import.meta.main) {
  const log: Log = (message) => console.log(`[prebuild] ${message}`)
  await prepareDesktopArtifacts({ staleOnly: false, log })
  log("Done.")
}
