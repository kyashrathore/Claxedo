#!/usr/bin/env bun
/**
 * Development-only preparation, then the shared artifacts with `staleOnly`.
 *
 * Dev runs the generic Electron.app from node_modules, so this renames and
 * relabels that bundle and makes the native modules loadable by its Electron.
 */

import { $ } from "bun"
import * as fs from "fs"
import { createRequire } from "node:module"
import * as path from "path"

import { readString } from "@claxedo/helpers/readers"

import { deriveDevIdentity, probeDevLabel } from "../src/main/dev-identity-policy"
import { prepareDesktopArtifacts } from "./prepare-artifacts"
import { resolveChannel } from "./utils"

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const SERVER_CORE_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server-core")
const require = createRequire(import.meta.url)
const log = (message: string) => console.log(`[predev] ${message}`)

// macOS reads the app name, identity and Mission Control icon from the bundle
// being run; packaged builds get all three from electron-builder.
await patchDevBundleMetadata()
await ensureElectronNativeModules()
await prepareDesktopArtifacts({ staleOnly: true, log })
log("Done.")

async function patchDevBundleMetadata() {
  if (process.platform !== "darwin") return
  // Named on the binding rather than asserted: `require` answers `any`, and
  // the guard below is what actually establishes the type.
  const electronBin: unknown = require("electron")
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
  const sourceIcon = path.resolve(PACKAGE_DIR, `icons/${resolveChannel()}/icon.icns`)
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
  // The menu-bar app name comes from the bundle, not app.setName(). Each
  // worktree has its own node_modules/electron bundle, so the patches never
  // collide.
  const displayName = deriveDevIdentity(probeDevLabel(path.resolve(PACKAGE_DIR, "../.."))).name
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
    log("Dev Electron bundle metadata is current")
    return
  }
  // Bump mtime so LaunchServices re-reads the bundle metadata.
  await $`touch ${appPath}`.quiet().catch(() => {})
  log(`Patched dev Electron bundle metadata → ${displayName}`)
}

async function ensureElectronNativeModules() {
  const betterSqliteDir = path.dirname(resolvePackageFile("better-sqlite3/package.json"))

  if (electronCanLoadBetterSqlite()) return
  signNativeModules([betterSqliteDir, lydellPtyPlatformDir()].filter((dir): dir is string => !!dir))

  if (electronCanLoadBetterSqlite()) return

  const electronVersion = readPackageVersion("electron")
  if (!electronVersion) throw new Error("Could not resolve electron package version")

  log(`Rebuilding better-sqlite3 for Electron ${electronVersion}...`)
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
  const raw: unknown = JSON.parse(fs.readFileSync(resolvePackageFile(`${packageName}/package.json`), "utf8"))
  return readString(raw, "version")
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
