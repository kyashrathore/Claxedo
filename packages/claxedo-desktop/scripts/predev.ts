#!/usr/bin/env bun
/**
 * Pre-dev script for Claxedo Electron desktop app.
 *
 * Builds the patched OpenCode CLI, SDK-next embedded engine, and copies icons.
 */

import { $ } from "bun"
import * as fs from "fs"
import { createRequire } from "node:module"
import * as path from "path"

import { bundleClaxedoEngineWorker, bundleClaxedoServer, resolveDeferredServerEntry } from "./bundle-claxedo-server"
import {
  buildClaxedoServerCompileCache,
  buildOpenCodeCompileCache,
  resolveElectronBinary,
} from "./build-opencode-compile-cache"
import { bundleHostConnector } from "./bundle-host-connector"
import {
  CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME,
  OPENCODE_COMPILE_CACHE_DIR_NAME,
  OPENCODE_COMPILE_CACHE_MANIFEST_NAME,
} from "../src/shared/opencode-compile-cache"
import { buildMemoryImpactHelper } from "./build-memory-impact-helper"
import {
  LOCAL_SERVER_ENTRY,
  localServerBundleEntry,
  localServerPackageDir,
  resolveLocalServerEntry,
} from "./local-server"
import { prepareRichContentRenderer } from "./build-rich-content-renderer"
import { copyIcons, copyWorkspaceRuntimeTemplates } from "./utils"

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
// The desktop server IS `@claxedo/local-server`. `claxedo-server` is the hosted
// and self-hosted product; nothing the desktop ships comes from it. `prebuild`
// resolves through the same module, so development and production preparation
// cannot drift apart.
const CLAXEDO_SERVER_DIR = localServerPackageDir(PACKAGE_DIR)
const SERVER_CORE_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server-core")
const AGENT_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../agent-sdk-runtime")
const OPENCODE_DIR = path.resolve(PACKAGE_DIR, "../opencode")
const WS_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../workspace-runtime")
const require = createRequire(import.meta.url)

try {
  const copied = copyIcons()
  console.log(`Copied ${copied.channel} icons from ${copied.src} to ${copied.dest}`)
} catch (e) {
  console.warn(`[predev] ${e instanceof Error ? e.message : String(e)}, skipping icon copy`)
}

try {
  const copied = copyWorkspaceRuntimeTemplates(path.resolve(PACKAGE_DIR, "templates"))
  console.log(`Copied workspace-runtime templates from ${copied.src} to ${copied.dest}`)
} catch (e) {
  console.warn(`[predev] ${e instanceof Error ? e.message : String(e)}, skipping template copy`)
}

// In dev we run the generic Electron.app binary, so macOS reads the app name,
// identity, and Mission Control icon from that bundle. Packaged builds receive
// all three from electron-builder; patch the shared dev bundle to match them.
try {
  await patchDevBundleMetadata()
} catch (e) {
  console.warn(`[predev] ${e instanceof Error ? e.message : String(e)}, skipping dev app metadata patch`)
}

await ensureElectronNativeModules()
const [, , hostConnector] = await Promise.all([
  buildMemoryImpactHelper(),
  prepareRichContentRenderer(),
  bundleHostConnector(),
])
console.log(`[predev] Host Connector child bundled (${hostConnector.manifest.sha256})`)

async function patchDevBundleMetadata() {
  if (process.platform !== "darwin") return
  const electronBin = require("electron") as unknown as string
  if (typeof electronBin !== "string") return
  const marker = "/Contents/"
  const at = electronBin.indexOf(marker)
  if (at < 0) return
  const sourceAppPath = electronBin.slice(0, at) // …/Electron.app
  const appPath = path.join(path.dirname(sourceAppPath), "Claxedo Dev.app")
  const changes: boolean[] = []
  if (sourceAppPath !== appPath) {
    if (fs.existsSync(appPath)) throw new Error(`Dev app bundle already exists at ${appPath}`)
    fs.renameSync(sourceAppPath, appPath)
    changes.push(true)
  }
  const plist = path.join(appPath, "Contents", "Info.plist")
  if (!fs.existsSync(plist)) return
  const icon = "claxedo-dev.icns"
  const executable = "Claxedo Dev"
  const sourceExecutable = path.join(appPath, "Contents", "MacOS", path.basename(electronBin))
  const targetExecutable = path.join(appPath, "Contents", "MacOS", executable)
  if (sourceExecutable !== targetExecutable && fs.existsSync(sourceExecutable)) {
    fs.renameSync(sourceExecutable, targetExecutable)
    changes.push(true)
  }
  const sourceIcon = path.resolve(PACKAGE_DIR, "resources/icons/icon.icns")
  const targetIcon = path.join(appPath, "Contents", "Resources", icon)
  if (!fs.existsSync(targetIcon) || !fs.readFileSync(sourceIcon).equals(fs.readFileSync(targetIcon))) {
    fs.copyFileSync(sourceIcon, targetIcon)
    changes.push(true)
  }
  const setKey = async (key: string, value: string, type: "bool" | "string" = "string") => {
    const current = await $`/usr/libexec/PlistBuddy -c ${`Print :${key}`} ${plist}`
      .quiet()
      .text()
      .then((output) => output.trim())
      .catch(() => undefined)
    if (current === value) return false
    try {
      await $`/usr/libexec/PlistBuddy -c ${`Set :${key} ${value}`} ${plist}`.quiet()
    } catch {
      await $`/usr/libexec/PlistBuddy -c ${`Add :${key} ${type} ${value}`} ${plist}`.quiet().catch(() => {})
    }
    return true
  }
  // The menu-bar app name comes from the bundle, not app.setName(): label it
  // per worktree so simultaneous dev builds are tellable apart. Each worktree
  // has its own node_modules/electron bundle, so the patches never collide.
  // Mirrors resolveDevIdentity in src/main/dev-identity.ts: a linked worktree
  // (.git is a file) is labeled with its directory name.
  // Mirrors probeDevLabel in src/main/dev-identity-policy.ts: a linked
  // worktree (.git is a file) is labeled with its directory name; the main
  // checkout is labeled with its current branch.
  const repoRoot = path.resolve(PACKAGE_DIR, "../..")
  const label = process.env.CLAXEDO_DEV_LABEL?.trim() || (() => {
    try {
      if (fs.statSync(path.join(repoRoot, ".git")).isFile()) return path.basename(repoRoot)
      const head = fs.readFileSync(path.join(repoRoot, ".git", "HEAD"), "utf8").trim()
      if (head.startsWith("ref: ")) return head.slice("ref: ".length).replace(/^refs\/heads\//, "")
      return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 8) : null
    } catch { return null }
  })()
  const displayName = label ? `Claxedo Dev (${label})` : "Claxedo Dev"
  changes.push(
    await setKey("CFBundleName", displayName),
    await setKey("CFBundleDisplayName", displayName),
    await setKey("CFBundleIdentifier", "ai.claxedo.desktop.dev"),
    await setKey("CFBundleIconFile", icon),
    await setKey("CFBundleExecutable", executable),
  )
  const electronPathFile = path.resolve(path.dirname(appPath), "../path.txt")
  const electronPath = path.join(path.basename(appPath), "Contents", "MacOS", executable)
  if (!fs.existsSync(electronPathFile) || fs.readFileSync(electronPathFile, "utf8") !== electronPath) {
    fs.writeFileSync(electronPathFile, electronPath)
    changes.push(true)
  }
  if (!changes.some(Boolean)) {
    console.log(`[predev] Dev Electron bundle metadata is current`)
    return
  }
  // Bump mtime so LaunchServices re-reads the bundle metadata.
  await $`touch ${appPath}`.quiet().catch(() => {})
  console.log(`[predev] Patched dev Electron bundle metadata → ${displayName}`)
}

// workspace-runtime consumes agent-sdk-runtime through its `dist` exports, so
// its build must never run against an older adapter than the source tree.
const agentRuntimeOutput = path.resolve(AGENT_RUNTIME_DIR, "dist/index.mjs")
if (outputIsStale(agentRuntimeOutput, [
  path.resolve(AGENT_RUNTIME_DIR, "package.json"),
  path.resolve(AGENT_RUNTIME_DIR, "scripts"),
  path.resolve(AGENT_RUNTIME_DIR, "src"),
])) {
  console.log(`[predev] Building agent-sdk-runtime...`)
  await $`bun run build`.cwd(AGENT_RUNTIME_DIR)
} else {
  console.log(`[predev] agent-sdk-runtime is current`)
}

// Bundle claxedo-server so dev mode doesn't rely on a stale prebuild artifact
const workspaceRuntimeOutput = path.resolve(WS_RUNTIME_DIR, "dist/host.mjs")
if (outputIsStale(workspaceRuntimeOutput, [
  path.resolve(WS_RUNTIME_DIR, "package.json"),
  path.resolve(WS_RUNTIME_DIR, "scripts"),
  path.resolve(WS_RUNTIME_DIR, "src"),
])) {
  console.log(`[predev] Building workspace-runtime...`)
  await $`bun run build`.cwd(WS_RUNTIME_DIR)
} else {
  console.log(`[predev] workspace-runtime is current`)
}

// The BOOT stub, not the product entry: it seeds the compile cache and then
// reaches `claxedo-server-entry.ts` through a dynamic import, so the 9.11 MB
// closure behind it is compiled after the cache is live.
const serverSource = path.resolve(SCRIPT_DIR, "claxedo-server-boot.ts")
const serverEntry = localServerBundleEntry(PACKAGE_DIR)
const serverDest = path.dirname(serverEntry)
let serverDeferredEntry: string | undefined
const workerSource = path.resolve(SCRIPT_DIR, "claxedo-engine-worker-entry.ts")
const workerPolicySource = path.resolve(SCRIPT_DIR, "claxedo-engine-worker-policy.ts")
const workerDest = path.resolve(PACKAGE_DIR, "resources/claxedo-engine-worker")
const workerEntry = path.join(workerDest, "index.js")
const embeddedOpenCode = path.resolve(OPENCODE_DIR, "dist/node/node.js")

if (outputIsStale(embeddedOpenCode, [
  path.resolve(OPENCODE_DIR, "package.json"),
  path.resolve(OPENCODE_DIR, "script/build-node.ts"),
  path.resolve(OPENCODE_DIR, "src"),
])) {
  console.log(`[predev] Building SDK-next embedded OpenCode...`)
  await $`bun run build:node`.cwd(OPENCODE_DIR)
} else {
  console.log(`[predev] SDK-next embedded OpenCode is current`)
}

// Same gate `prebuild` applies, for the same reason: an unresolvable
// `@claxedo/local-server` must stop here naming the package, not silently
// leave dev running yesterday's bundle.
console.log(`[predev] Local server entry: ${LOCAL_SERVER_ENTRY} → ${resolveLocalServerEntry(PACKAGE_DIR)}`)

if (fs.existsSync(serverSource) && outputIsStale(serverEntry, [
  path.resolve(SCRIPT_DIR, "bundle-claxedo-server.ts"),
  serverSource,
  path.resolve(SCRIPT_DIR, "claxedo-server-entry.ts"),
  path.resolve(PACKAGE_DIR, "src/shared/claxedo-server-lifecycle.ts"),
  path.resolve(CLAXEDO_SERVER_DIR, "src"),
  // The shared core beneath it. Without this, editing a core module leaves the
  // bundle looking current and the desktop runs stale code with nothing said.
  path.resolve(PACKAGE_DIR, "../claxedo-server-core/src"),
  // Compat routes (/auth, /provider, dispose) live here — same stale risk.
  path.resolve(PACKAGE_DIR, "../claxedo-local-server/src"),
  path.resolve(PACKAGE_DIR, "../agent-event-runtime/src"),
  path.resolve(PACKAGE_DIR, "../agent-sdk-runtime/src"),
  path.resolve(PACKAGE_DIR, "../sdk-next/src"),
  path.resolve(PACKAGE_DIR, "../workspace-runtime/src"),
])) {
  console.log(`[predev] Compiling standalone claxedo-server...`)
  const bundled = await bundleClaxedoServer(serverSource, serverDest)
  console.log(`[predev] claxedo-server compiled to ${bundled.entry} (${Math.ceil(bundled.outputBytes / 1024 / 1024)} MB standalone)`)
  serverDeferredEntry = bundled.deferredEntry
} else if (fs.existsSync(serverSource)) {
  console.log(`[predev] claxedo-server bundle is current`)
} else {
  console.warn(`[predev] claxedo-server source not found at ${serverSource}, skipping`)
}

// The compile cache embeds a hash of the engine SOURCE and of the V8 flags, so
// it must be regenerated whenever either changes. A stale cache is not a wrong
// answer — V8 rejects it and the engine compiles — but it is a silently lost
// ~155 ms, so it is gated on both inputs rather than on the engine alone.
const compileCacheDir = path.resolve(PACKAGE_DIR, "resources", OPENCODE_COMPILE_CACHE_DIR_NAME)
if (outputIsStale(path.join(compileCacheDir, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), [
  embeddedOpenCode,
  path.resolve(PACKAGE_DIR, "src/main/server-runtime-policy.ts"),
  path.resolve(SCRIPT_DIR, "build-opencode-compile-cache.ts"),
  path.resolve(PACKAGE_DIR, "src/shared/opencode-compile-cache.ts"),
])) {
  console.log(`[predev] Generating the OpenCode V8 compile cache...`)
  const compileCache = await buildOpenCodeCompileCache({
    enginePath: embeddedOpenCode,
    outputDir: compileCacheDir,
    electronPath: resolveElectronBinary(PACKAGE_DIR),
    log: (message) => console.log(`[predev] compile cache: ${message}`),
  })
  for (const entry of compileCache.manifest.entries) {
    console.log(`[predev] compile cache: ${entry.file} (${entry.type}, ${entry.bytes} bytes)`)
  }
} else {
  console.log(`[predev] OpenCode V8 compile cache is current`)
}

// The server bundle's own closure. Gated on the BUNDLE, because the bundle is
// what it caches: a chunk whose content hash moved is a source hash V8 rejects,
// which is not a wrong answer but is a silently lost 41 ms.
const serverCompileCacheDir = path.resolve(PACKAGE_DIR, "resources", CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME)
if (fs.existsSync(serverEntry)) {
  serverDeferredEntry ??= resolveDeferredServerEntry(serverEntry)
  if (outputIsStale(path.join(serverCompileCacheDir, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), [
    serverDeferredEntry,
    path.resolve(PACKAGE_DIR, "src/main/server-runtime-policy.ts"),
    path.resolve(SCRIPT_DIR, "build-opencode-compile-cache.ts"),
    path.resolve(PACKAGE_DIR, "src/shared/opencode-compile-cache.ts"),
  ])) {
    console.log(`[predev] Generating the claxedo-server V8 compile cache...`)
    const serverCache = await buildClaxedoServerCompileCache({
      deferredEntryPath: serverDeferredEntry,
      bundleDir: serverDest,
      outputDir: serverCompileCacheDir,
      electronPath: resolveElectronBinary(PACKAGE_DIR),
      log: (message) => console.log(`[predev] server compile cache: ${message}`),
    })
    const bytes = serverCache.manifest.entries.reduce((total, entry) => total + entry.bytes, 0)
    console.log(`[predev] server compile cache: ${serverCache.manifest.entries.length} entr(ies), ${bytes} bytes`)
  } else {
    console.log(`[predev] claxedo-server V8 compile cache is current`)
  }
}

if (outputIsStale(workerEntry, [workerSource, workerPolicySource, path.resolve(SCRIPT_DIR, "bundle-claxedo-server.ts")])) {
  console.log(`[predev] Bundling claxedo engine worker...`)
  await bundleClaxedoEngineWorker(workerSource, workerDest)
} else {
  console.log(`[predev] claxedo engine worker is current`)
}

console.log(`[predev] Done.`)

async function ensureElectronNativeModules() {
  const betterSqliteDir = path.dirname(resolvePackageFile("better-sqlite3/package.json"))

  if (electronCanLoadBetterSqlite()) return
  signNativeModules([betterSqliteDir, lydellPtyPlatformDir()].filter((dir): dir is string => !!dir))

  if (electronCanLoadBetterSqlite()) return

  const electronVersion = readPackageVersion("electron")
  if (!electronVersion) throw new Error("Could not resolve electron package version")

  console.log(`[predev] Rebuilding better-sqlite3 for Electron ${electronVersion}...`)
  await $`npx node-gyp rebuild --release --target=${electronVersion} --runtime=electron --dist-url=https://electronjs.org/headers`.cwd(
    betterSqliteDir,
  )

  signNativeModules([betterSqliteDir])

  if (!electronCanLoadBetterSqlite()) {
    throw new Error("better-sqlite3 still failed to load in Electron after rebuild")
  }
}

function electronCanLoadBetterSqlite() {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      resolvePackageFile("electron/cli.js"),
      "-e",
      [
        `const { createRequire } = require("node:module")`,
        `const requireFromSqliteOwner = createRequire(${JSON.stringify(path.join(SERVER_CORE_DIR, "package.json"))})`,
        `const Database = requireFromSqliteOwner("better-sqlite3")`,
        `const db = new Database(":memory:")`,
        `db.close()`,
      ].join(";"),
    ],
    cwd: PACKAGE_DIR,
    env: { ...Bun.env, ELECTRON_RUN_AS_NODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode === 0) return true

  const output = [result.stdout, result.stderr]
    .map((chunk) => new TextDecoder().decode(chunk).trim())
    .filter(Boolean)
    .join("\n")
  if (output) console.warn(`[predev] Electron native smoke test failed:\n${output}`)
  return false
}

function readPackageVersion(packageName: string) {
  const raw = JSON.parse(fs.readFileSync(resolvePackageFile(`${packageName}/package.json`), "utf8")) as {
    version?: unknown
  }
  return typeof raw.version === "string" ? raw.version : undefined
}

function optionalPackageDir(packageName: string) {
  try {
    return path.dirname(resolvePackageFile(`${packageName}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * `@lydell/node-pty`'s platform binary package for THIS host. bun links the
 * optionalDependency only inside its store, so it is unreachable by name from
 * here — but require.resolve realpaths the wrapper into the store, where the
 * platform package is always the wrapper's scope sibling.
 */
function lydellPtyPlatformDir() {
  const wrapper = optionalPackageDir("@lydell/node-pty")
  if (!wrapper) return undefined
  const dir = path.join(path.dirname(wrapper), `node-pty-${process.platform}-${process.arch}`)
  return fs.existsSync(dir) ? dir : undefined
}

function resolvePackageFile(specifier: string) {
  return require.resolve(specifier, { paths: [PACKAGE_DIR] })
}

function signNativeModules(packageDirs: string[]) {
  if (process.platform !== "darwin") return

  const nativeFiles = packageDirs.flatMap((dir) => findNativeFiles(dir))
  for (const file of nativeFiles) {
    const result = Bun.spawnSync({
      cmd: ["codesign", "--force", "--sign", "-", file],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) {
      throw new Error(`codesign failed for ${file}: ${new TextDecoder().decode(result.stderr).trim()}`)
    }
  }
}

function findNativeFiles(dir: string) {
  if (!fs.existsSync(dir)) return []

  const pending = [dir]
  const files: string[] = []
  while (pending.length) {
    const current = pending.pop()
    if (!current) continue
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const itemPath = path.join(current, item.name)
      if (item.isDirectory()) {
        pending.push(itemPath)
        continue
      }
      if (item.isFile() && item.name.endsWith(".node")) files.push(itemPath)
    }
  }
  return files
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
