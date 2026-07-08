#!/usr/bin/env bun
/**
 * Pre-dev script for Claxedo Electron desktop app.
 *
 * Builds the patched OpenCode sidecar and copies icons.
 */

import { $ } from "bun"
import * as fs from "fs"
import { createRequire } from "node:module"
import * as path from "path"

import { copyBinaryToSidecarFolder, copyIcons, copyWorkspaceRuntimeTemplates, getCurrentSidecar, windowsify } from "./utils"

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const CLAXEDO_SERVER_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server")
const OPENCODE_DIR = path.resolve(PACKAGE_DIR, "../opencode")
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

await ensureElectronNativeModules()

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

// Bundle claxedo-server so dev mode doesn't rely on a stale prebuild artifact
const serverSource = path.resolve(CLAXEDO_SERVER_DIR, "src/server.ts")
const serverDest = path.resolve(PACKAGE_DIR, "resources/claxedo-server.js")

if (fs.existsSync(serverSource)) {
  console.log(`[predev] Bundling claxedo-server...`)
  await $`bun build ${serverSource} --outfile ${serverDest} --target=node --external better-sqlite3 --external node-pty --external jsonc-parser`
  console.log(`[predev] claxedo-server bundled to ${serverDest}`)
} else {
  console.warn(`[predev] claxedo-server source not found at ${serverSource}, skipping`)
}

console.log(`[predev] Done.`)

async function ensureElectronNativeModules() {
  const betterSqliteDir = path.dirname(resolvePackageFile("better-sqlite3/package.json"))

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
