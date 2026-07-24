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
import { codexAcpTarget } from "./codex-acp-target"
import { copyBinaryToSidecarFolder, copyIcons as copyChannelIcons, getCurrentSidecar, targetPlatformArch, windowsify } from "./utils"

// ── Paths ──

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const CLAXEDO_SERVER_DIR = path.resolve(PACKAGE_DIR, "../claxedo-server")
const OPENCODE_DIR = path.resolve(PACKAGE_DIR, "../opencode")
const WS_RUNTIME_DIR = path.resolve(PACKAGE_DIR, "../workspace-runtime")
const ROOT_NODE_MODULES = path.resolve(PACKAGE_DIR, "../../node_modules")
const RESOURCES_DIR = path.resolve(PACKAGE_DIR, "resources")
const ACP_DIR = path.resolve(RESOURCES_DIR, "acp")

const log = (msg: string) => console.log(`[prebuild] ${msg}`)
const warn = (msg: string) => console.warn(`[prebuild] ${msg}`)

// ── Helpers ──

/** Resolve a package file from bun's hoisted .bun/ dir, then from a local fallback. */
function resolveBunPackage(pkgPrefix: string, subpath: string, localFallbackDir?: string): string | undefined {
  const bunDir = path.resolve(ROOT_NODE_MODULES, ".bun")
  if (fs.existsSync(bunDir)) {
    // Prefer the highest version when the store holds several (numeric sort
    // so 0.23.x beats 0.9.x).
    const matches = fs
      .readdirSync(bunDir)
      .filter((d) => d.startsWith(pkgPrefix))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const match of matches) {
      const candidate = path.join(bunDir, match, "node_modules", subpath)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  if (localFallbackDir) {
    const direct = path.resolve(localFallbackDir, "node_modules", subpath)
    if (fs.existsSync(direct)) return direct
  }
  return undefined
}

// ── Icons ──

async function copyIcons() {
  const copied = copyChannelIcons()
  log(`Copied ${copied.channel} icons`)
}

// ── Sidecar binary ──

async function buildSidecar() {
  const sidecarConfig = getCurrentSidecar()
  const binaryPath = windowsify(path.resolve(OPENCODE_DIR, `dist/${sidecarConfig.ocBinary}/bin/opencode`))
  const existingBinary = windowsify(path.resolve(RESOURCES_DIR, "opencode-cli"))
  const models = Bun.env.MODELS_DEV_API_JSON ?? path.join("test", "tool", "fixtures", "models-api.json")

  log("Building patched OpenCode sidecar...")
  try {
    const target = targetPlatformArch()
    const cross = target.platform !== process.platform || target.arch !== process.arch
    // Claxedo ships its own Electron renderer, so skip embedding upstream's
    // web UI in the sidecar — its source (packages/app) was removed in the fork.
    const flags = ["--single"]
    if (sidecarConfig.ocBinary.includes("-baseline")) flags.push("--baseline")
    // A cross build must NOT skip install: build.ts's install step is what
    // pulls the all-platform variants of the native deps (@ff-labs/fff-bun,
    // @opentui/core, @parcel/watcher) the target arch resolves against.
    if (!cross) flags.push("--skip-install")
    flags.push("--skip-embed-web-ui")
    await $`bun run build ${flags}`.cwd(OPENCODE_DIR).env({
      ...Bun.env,
      MODELS_DEV_API_JSON: models,
      // Cross-compile the sidecar for the RUST_TARGET arch (bun downloads
      // the target's bun binary); without these a CI x64 build on an arm64
      // runner produces an arm64 sidecar the copy step can't find.
      OPENCODE_BUILD_OS: target.platform,
      OPENCODE_BUILD_ARCH: target.arch,
    })

    await copyBinaryToSidecarFolder(binaryPath)
  } catch (e) {
    if (Bun.env.CLAXEDO_ALLOW_STALE_SIDECAR === "1" && fs.existsSync(existingBinary)) {
      warn("Sidecar build failed, using existing binary from resources/opencode-cli")
    } else {
      throw e
    }
  }
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
  const target = targetPlatformArch()
  const codexTarget = codexAcpTarget(target.platform, target.arch)

  const desktopPkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"))
  const version = desktopPkg.devDependencies?.["@openai/codex"]
  const resolveVendor = () =>
    resolveBunPackage(
      `@openai+codex@${version}-${target.platform}-${target.arch}`,
      `@openai/codex/vendor/${codexTarget.triple}`,
      WS_RUNTIME_DIR,
    )

  const vendor = resolveVendor() ?? (() => {
    if (!version) return
    log(`Codex ${target.platform}-${target.arch} vendor not in store; installing all-platform variants...`)
    const result = Bun.spawnSync(
      ["bun", "install", `--os=*`, `--cpu=*`],
      { cwd: PACKAGE_DIR, stdout: "inherit", stderr: "inherit" },
    )
    if (result.exitCode !== 0) return
    return resolveVendor()
  })()
  if (!vendor) throw new Error(`Codex vendor not found for ${target.platform}/${target.arch}`)

  fs.rmSync(path.resolve(ACP_DIR, "codex-acp"), { force: true })
  fs.rmSync(path.resolve(ACP_DIR, "codex-acp.exe"), { force: true })
  fs.rmSync(path.resolve(ACP_DIR, "codex-vendor"), { recursive: true, force: true })

  const dest = path.resolve(ACP_DIR, target.platform === "win32" ? "codex-acp.exe" : "codex-acp")
  log(`Bundling codex-acp for ${target.platform}-${target.arch}...`)
  await $`bun build ${path.resolve(SCRIPT_DIR, "codex-acp-entry.ts")} --compile --target=${codexTarget.bun} --outfile ${dest}`

  const vendorDest = path.resolve(ACP_DIR, "codex-vendor", codexTarget.triple)
  fs.mkdirSync(path.dirname(vendorDest), { recursive: true })
  fs.cpSync(vendor, vendorDest, { recursive: true })
  if (target.platform !== "win32") {
    fs.chmodSync(dest, 0o755)
    fs.chmodSync(path.join(vendorDest, "bin", "codex"), 0o755)
  }
  log("codex-acp and Codex app-server vendor bundled")
}

async function copyAcpBinaries() {
  fs.mkdirSync(ACP_DIR, { recursive: true })
  await bundleClaudeAgentAcp()
  await bundleCodexAcp()
}

// ── Main ──

// The installable CLI and desktop server share generated resources, so keep them in
// sequence. Icon and ACP copying are independent and run alongside them.
await Promise.all([
  copyIcons(),
  copyAcpBinaries(),
  (async () => {
    await buildSidecar()
    await bundleServer()
  })(),
])

log("Done.")
