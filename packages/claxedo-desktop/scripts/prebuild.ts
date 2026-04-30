#!/usr/bin/env bun
/**
 * Pre-build script for Claxedo Electron desktop app.
 *
 * Rebuilds the sidecar binary, bundles server components,
 * copies ACP binaries, and copies channel-specific icons —
 * so that `bun run build` + `bun run package:mac` produces
 * a fully up-to-date app.
 */

import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"

import { copyBinaryToSidecarFolder, getCurrentSidecar, resolveChannel, windowsify } from "./utils"

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
    const match = fs.readdirSync(bunDir).find((d) => d.startsWith(pkgPrefix))
    if (match) {
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

/** Copy a file and make it executable. */
function copyExecutable(src: string, dest: string) {
  fs.copyFileSync(src, dest)
  fs.chmodSync(dest, 0o755)
}

// ── Icons ──

async function copyIcons() {
  const channel = resolveChannel()
  const src = path.resolve(PACKAGE_DIR, `icons/${channel}`)
  const dest = path.resolve(RESOURCES_DIR, "icons")

  if (!fs.existsSync(src)) {
    throw new Error(`Icons dir not found at ${src}`)
  }
  await $`rm -rf ${dest}`
  await $`cp -R ${src} ${dest}`
  log(`Copied ${channel} icons`)
}

// ── Sidecar binary ──

async function buildSidecar() {
  const sidecarConfig = getCurrentSidecar()
  const binaryPath = windowsify(path.resolve(OPENCODE_DIR, `dist/${sidecarConfig.ocBinary}/bin/opencode`))
  const existingBinary = windowsify(path.resolve(RESOURCES_DIR, "opencode-cli"))
  const models = Bun.env.MODELS_DEV_API_JSON ?? path.join("test", "tool", "fixtures", "models-api.json")

  log("Building patched OpenCode sidecar...")
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
    if (Bun.env.CLAXEDO_ALLOW_STALE_SIDECAR === "1" && fs.existsSync(existingBinary)) {
      warn("Sidecar build failed, using existing binary from resources/opencode-cli")
    } else {
      throw e
    }
  }
}

// ── claxedo-mcp ──

async function bundleMcp() {
  const src = path.resolve(CLAXEDO_SERVER_DIR, "src/claxedo-mcp/server.ts")
  const dest = path.resolve(RESOURCES_DIR, "claxedo-mcp.js")

  if (!fs.existsSync(src)) {
    throw new Error(`claxedo-mcp source not found at ${src}`)
  }
  log("Bundling claxedo-mcp...")
  await $`bun build ${src} --outfile ${dest} --target=node --minify`
  log("claxedo-mcp bundled")
}

// ── claxedo-server ──

async function bundleServer() {
  const src = path.resolve(CLAXEDO_SERVER_DIR, "src/server.ts")
  const dest = path.resolve(RESOURCES_DIR, "claxedo-server.js")

  if (!fs.existsSync(src)) {
    throw new Error(`claxedo-server source not found at ${src}`)
  }
  log("Bundling claxedo-server...")
  await $`bun build ${src} --outfile ${dest} --target=node --external better-sqlite3 --external node-pty --external jsonc-parser`
  log("claxedo-server bundled")
}

// ── ACP binaries ──

async function bundleClaudeAgentAcp() {
  const entry = path.resolve(WS_RUNTIME_DIR, "node_modules/@zed-industries/claude-agent-acp/dist/index.js")
  if (!fs.existsSync(entry)) {
    warn("claude-agent-acp not found, skipping")
    return
  }

  const dest = path.resolve(ACP_DIR, "claude-agent-acp")
  const tmpDir = path.resolve(ACP_DIR, ".claude-acp-tmp")

  log("Bundling claude-agent-acp...")
  await $`bun build ${entry} --outdir ${tmpDir} --target=node`
  // Take only index.js; CLI vendor chunk is not needed for ACP mode
  let bundled = fs.readFileSync(path.join(tmpDir, "index.js"), "utf-8")
  // Strip any existing shebang before adding ours (avoids duplicate shebang)
  bundled = bundled.replace(/^#!.*\n/, "")
  fs.writeFileSync(dest, `#!/usr/bin/env node\n${bundled}`)
  fs.chmodSync(dest, 0o755)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  log("claude-agent-acp bundled")
}

function copyCodexAcp() {
  const pkgName = `codex-acp-${process.platform}-${process.arch}`
  const binPath = resolveBunPackage(
    `@zed-industries+${pkgName}@`,
    `@zed-industries/${pkgName}/bin/codex-acp`,
    WS_RUNTIME_DIR,
  )

  if (!binPath) {
    warn(`codex-acp native binary not found for ${process.platform}-${process.arch}, skipping`)
    return
  }
  copyExecutable(binPath, path.resolve(ACP_DIR, "codex-acp"))
  log("codex-acp binary copied")
}

/**
 * claude-agent-acp spawns a real Claude Code CLI subprocess for queries.
 * Copy cli.js + platform vendor binaries from @anthropic-ai/claude-agent-sdk.
 */
function copyClaudeSdkCli() {
  const sdkCliPath = resolveBunPackage(
    "@anthropic-ai+claude-agent-sdk@",
    "@anthropic-ai/claude-agent-sdk/cli.js",
    WS_RUNTIME_DIR,
  )

  if (!sdkCliPath) {
    warn("claude-agent-sdk cli.js not found, skipping")
    return
  }
  copyExecutable(sdkCliPath, path.resolve(ACP_DIR, "claude-cli.js"))
  log("claude-agent-sdk cli.js copied")

  // Copy platform-specific vendor binaries (ripgrep, tree-sitter, audio-capture)
  const vendorSrc = path.join(path.dirname(sdkCliPath), "vendor")
  if (!fs.existsSync(vendorSrc)) return

  const platKey = `${process.arch}-${process.platform}`
  const vendorDest = path.resolve(ACP_DIR, "vendor")

  for (const tool of fs.readdirSync(vendorSrc)) {
    const platDir = path.join(vendorSrc, tool, platKey)
    if (!fs.existsSync(platDir) || !fs.statSync(platDir).isDirectory()) continue

    const destDir = path.join(vendorDest, tool, platKey)
    fs.mkdirSync(destDir, { recursive: true })
    for (const f of fs.readdirSync(platDir)) {
      copyExecutable(path.join(platDir, f), path.join(destDir, f))
    }
    log(`vendor/${tool}/${platKey} copied`)
  }
}

async function copyAcpBinaries() {
  fs.mkdirSync(ACP_DIR, { recursive: true })
  await bundleClaudeAgentAcp()
  copyCodexAcp()
  copyClaudeSdkCli()
}

// ── Main ──

await Promise.all([
  copyIcons(),
  buildSidecar(),
  bundleMcp(),
  bundleServer(),
  copyAcpBinaries(),
])

log("Done.")
