#!/usr/bin/env bun
/**
 * Pre-build script for Claxedo Electron desktop app.
 *
 * Rebuilds the installable CLI and embedded engine, bundles server components,
 * copies ACP binaries, and copies channel-specific icons —
 * so that `bun run build` + `bun run package:mac` produces
 * a fully up-to-date app.
 */

import { $ } from "bun"
import * as fs from "fs"
import { createRequire } from "node:module"
import * as path from "path"

import { bundleClaxedoServer } from "./bundle-claxedo-server"
import { buildMemoryImpactHelper } from "./build-memory-impact-helper"
import { copyIcons as copyChannelIcons } from "./utils"

// ── Paths ──

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const CLAXEDO_SERVER_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server")
const OPENCODE_DIR = path.resolve(PACKAGE_DIR, "../opencode")
const WS_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../workspace-runtime")
const RESOURCES_DIR = path.resolve(PACKAGE_DIR, "resources")
const ACP_DIR = path.resolve(RESOURCES_DIR, "acp")

const log = (msg: string) => console.log(`[prebuild] ${msg}`)

// ── Icons ──

async function copyIcons() {
  const copied = copyChannelIcons()
  log(`Copied ${copied.channel} icons`)
}

// ── claxedo-server ──

async function bundleServer() {
  const src = path.resolve(SCRIPT_DIR, "claxedo-server-entry.ts")
  const dest = path.resolve(RESOURCES_DIR, "claxedo-server")

  if (!fs.existsSync(src)) {
    throw new Error(`claxedo-server source not found at ${src}`)
  }
  log("Building workspace-runtime...")
  await $`bun run build`.cwd(WS_RUNTIME_DIR)
  log("Building SDK-next embedded OpenCode...")
  await $`bun run build:node`.cwd(OPENCODE_DIR)
  log("Bundling claxedo-server...")
  const bundled = await bundleClaxedoServer(src, dest)
  log(`claxedo-server bundled to ${bundled.entry} (${Math.ceil(bundled.outputBytes / 1024 / 1024)} MB split)`)
}

// ── ACP binaries ──

async function bundleClaudeAgentAcp() {
  const desktopPkg = await Bun.file(path.resolve(PACKAGE_DIR, "package.json")).json()
  const version = desktopPkg.devDependencies?.["@agentclientprotocol/claude-agent-acp"]
  if (!version) throw new Error("claxedo-desktop is missing @agentclientprotocol/claude-agent-acp")
  const require = createRequire(path.resolve(PACKAGE_DIR, "package.json"))
  const packagePath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json")
  const installed = await Bun.file(packagePath).json()
  if (installed.version !== version) {
    throw new Error(`claude-agent-acp version mismatch: expected ${version}, found ${installed.version}`)
  }
  const entry = path.resolve(path.dirname(packagePath), "dist/index.js")
  if (!fs.existsSync(entry)) throw new Error(`claude-agent-acp entry not found at ${entry}`)

  const dest = path.resolve(ACP_DIR, "claude-agent-acp")
  const tmpDir = path.resolve(ACP_DIR, ".claude-acp-tmp")

  log("Bundling claude-agent-acp...")
  await $`bun build ${entry} --outdir ${tmpDir} --target=node`
  let bundled = fs.readFileSync(path.join(tmpDir, "index.js"), "utf-8")
  bundled = bundled.replace(/^#!.*\n/, "")
  fs.writeFileSync(
    dest,
    `#!/usr/bin/env node
if (Number.parseInt(process.versions.node, 10) < 22) {
  console.error("Claude ACP requires Node.js 22 or newer. Install Node 22+ and restart Claxedo.")
  process.exit(1)
}
${bundled}`,
  )
  fs.chmodSync(dest, 0o755)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  log("claude-agent-acp bundled")
}

async function bundleCodexAcp() {
  const dest = path.resolve(ACP_DIR, "codex-acp")
  const tmpDir = path.resolve(ACP_DIR, ".codex-acp-tmp")

  fs.rmSync(dest, { force: true })
  fs.rmSync(`${dest}.exe`, { force: true })
  fs.rmSync(path.resolve(ACP_DIR, "codex-vendor"), { recursive: true, force: true })

  // Plain bundled JS like claude-agent-acp — Node 22+ auto-detects the ESM
  // syntax in the extensionless file. No runtime ships inside the app: the
  // adapter runs on the user's Node and spawns the user's system `codex`.
  log("Bundling codex-acp...")
  await $`bun build ${path.resolve(SCRIPT_DIR, "codex-acp-entry.ts")} --outdir ${tmpDir} --target=node`
  let bundled = fs.readFileSync(path.join(tmpDir, "codex-acp-entry.js"), "utf-8")
  bundled = bundled.replace(/^#!.*\n/, "")
  fs.writeFileSync(
    dest,
    `#!/usr/bin/env node
if (Number.parseInt(process.versions.node, 10) < 22) {
  console.error("Codex ACP requires Node.js 22 or newer. Install Node 22+ and restart Claxedo.")
  process.exit(1)
}
${bundled}`,
  )
  fs.chmodSync(dest, 0o755)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  log("codex-acp bundled")
}

async function copyAcpBinaries() {
  fs.mkdirSync(ACP_DIR, { recursive: true })
  await bundleClaudeAgentAcp()
  await bundleCodexAcp()
}

// ── Main ──

// Icon and ACP copying are independent of the server bundle and run alongside it.
await Promise.all([copyIcons(), copyAcpBinaries(), bundleServer(), buildMemoryImpactHelper()])

log("Done.")
