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

import { bundleClaxedoEngineWorker, bundleClaxedoServer } from "./bundle-claxedo-server"
import { copyIcons, copyWorkspaceRuntimeTemplates } from "./utils"

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const CLAXEDO_SERVER_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server")
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
  changes.push(
    await setKey("CFBundleName", "Claxedo Dev"),
    await setKey("CFBundleDisplayName", "Claxedo Dev"),
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
  console.log(`[predev] Patched dev Electron bundle metadata → Claxedo Dev`)
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

const serverSource = path.resolve(SCRIPT_DIR, "claxedo-server-entry.ts")
const serverDest = path.resolve(PACKAGE_DIR, "resources/claxedo-server")
const serverEntry = path.join(serverDest, "index.js")
const workerSource = path.resolve(SCRIPT_DIR, "claxedo-engine-worker-entry.ts")
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

if (fs.existsSync(serverSource) && outputIsStale(serverEntry, [
  path.resolve(SCRIPT_DIR, "bundle-claxedo-server.ts"),
  serverSource,
  path.resolve(CLAXEDO_SERVER_DIR, "src"),
  path.resolve(PACKAGE_DIR, "../agent-event-runtime/src"),
  path.resolve(PACKAGE_DIR, "../agent-sdk-runtime/src"),
  path.resolve(PACKAGE_DIR, "../sdk-next/src"),
  path.resolve(PACKAGE_DIR, "../workgraph/src"),
  path.resolve(PACKAGE_DIR, "../workspace-runtime/src"),
])) {
  console.log(`[predev] Bundling claxedo-server...`)
  const bundled = await bundleClaxedoServer(serverSource, serverDest)
  console.log(`[predev] claxedo-server bundled to ${bundled.entry} (${Math.ceil(bundled.outputBytes / 1024 / 1024)} MB split)`)
} else if (fs.existsSync(serverSource)) {
  console.log(`[predev] claxedo-server bundle is current`)
} else {
  console.warn(`[predev] claxedo-server source not found at ${serverSource}, skipping`)
}

if (outputIsStale(workerEntry, [workerSource, path.resolve(SCRIPT_DIR, "bundle-claxedo-server.ts")])) {
  console.log(`[predev] Bundling claxedo engine worker...`)
  await bundleClaxedoEngineWorker(workerSource, workerDest)
} else {
  console.log(`[predev] claxedo engine worker is current`)
}

console.log(`[predev] Done.`)

async function ensureElectronNativeModules() {
  const betterSqliteDir = path.dirname(resolvePackageFile("better-sqlite3/package.json"))

  if (electronCanLoadBetterSqlite()) return
  signNativeModules([betterSqliteDir, optionalPackageDir("node-pty")].filter((dir): dir is string => !!dir))

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
        `const requireFromServer = createRequire(${JSON.stringify(path.join(CLAXEDO_SERVER_DIR, "package.json"))})`,
        `const Database = requireFromServer("better-sqlite3")`,
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
