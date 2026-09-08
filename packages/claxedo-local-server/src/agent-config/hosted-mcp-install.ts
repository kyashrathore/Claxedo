import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { asRecord } from "@claxedo/helpers/guards"
import { parse as parseToml } from "smol-toml"

/** What the entry is called in every harness's config, and how a user recognises it. */
export const HOSTED_MCP_SERVER_NAME = "claxedo"

const CODEX_BLOCK_START = "# >>> claxedo mcp (managed) >>>"
const CODEX_BLOCK_END = "# <<< claxedo mcp (managed) <<<"

export type HostedMcpHarness = "claude" | "codex" | "cursor"

export type HostedMcpInstallResult = {
  harness: HostedMcpHarness
  file: string
  state: "written" | "removed" | "unchanged"
}

export class HostedMcpUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostedMcpUrlError"
  }
}

/**
 * The URL a harness on this machine should be told to reach.
 *
 * Loopback is refused rather than written. The local endpoint admits only the
 * credential the runtime injects into a session it launched, so a user who
 * copied a `127.0.0.1` entry into Claude Code would get 401s on this machine
 * and nothing at all from their phone — and the entry would follow them into
 * every project they opened.
 */
export function hostedMcpUrl(controlPlaneUrl: string) {
  let origin: URL
  try {
    origin = new URL(controlPlaneUrl)
  } catch {
    throw new HostedMcpUrlError(`${controlPlaneUrl} is not a URL`)
  }
  if (origin.protocol !== "https:") {
    throw new HostedMcpUrlError("A shared MCP entry must name an https control plane")
  }
  // Every spelling of "this machine", including the rest of 127.0.0.0/8 and
  // the `.localhost` suffix a dev proxy resolves. Broadening here is
  // fail-safe: the worst it does is refuse to write an entry.
  const host = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.startsWith("127.")) {
    throw new HostedMcpUrlError("A shared MCP entry must not name this machine's loopback endpoint")
  }
  return `${origin.origin}/api/claxedo/mcp`
}

export type HostedMcpInstallPaths = {
  /** Defaults to the user's home directory. */
  home?: string
  /** Defaults to `$CODEX_HOME`, else `<home>/.codex`. */
  codexHome?: string
}

function harnessConfigFiles(paths: HostedMcpInstallPaths, env: NodeJS.ProcessEnv) {
  const home = paths.home ?? os.homedir()
  return {
    claude: path.join(home, ".claude.json"),
    cursor: path.join(home, ".cursor", "mcp.json"),
    codex: path.join(paths.codexHome ?? env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"),
  } as const
}

async function readIfPresent(file: string) {
  return await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

/** Replaces the file only after it is fully written, so a crash cannot leave a harness with half a config. */
async function replaceFileAtomically(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.claxedo-${crypto.randomUUID()}`)
  const mode = await fs.stat(file).then((stat) => stat.mode & 0o777, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0o600
    throw error
  })
  try {
    await fs.writeFile(temporary, contents, { mode })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function prepareJsonConfig(file: string, url: string | undefined): Promise<{ state: HostedMcpInstallResult["state"]; contents?: string }> {
  const current = await readIfPresent(file)
  // A config a harness cannot parse is a config the user is already fighting;
  // silently replacing it would take their servers with it.
  const config = asRecord(current === undefined || current.trim() === "" ? {} : JSON.parse(current))
  if (!config) throw new Error(`${file} is not a JSON object`)
  const servers = { ...asRecord(config.mcpServers) }
  const entry = url === undefined ? undefined : { type: "http", url }
  const existing = servers[HOSTED_MCP_SERVER_NAME]
  if (JSON.stringify(existing) === JSON.stringify(entry)) return { state: "unchanged" }
  if (entry) servers[HOSTED_MCP_SERVER_NAME] = entry
  else delete servers[HOSTED_MCP_SERVER_NAME]
  return { contents: `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, state: url === undefined ? "removed" : "written" }
}

/**
 * Codex owns `config.toml`, so the entry lives inside a marked block that is
 * replaced whole. Everything outside the markers is the user's, including
 * their own `[mcp_servers.*]` tables.
 */
async function prepareCodexConfig(file: string, url: string | undefined): Promise<{ state: HostedMcpInstallResult["state"]; contents?: string }> {
  const current = (await readIfPresent(file)) ?? ""
  const start = current.indexOf(CODEX_BLOCK_START)
  const end = current.indexOf(CODEX_BLOCK_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Codex config ${file} contains a damaged Claxedo MCP block`)
  }
  const before = start === -1 ? current : current.slice(0, start)
  const after = start === -1 ? "" : current.slice(end + CODEX_BLOCK_END.length)
  const unmanaged = `${before.trimEnd()}\n${after.trimStart()}`.trim()
  const existing = asRecord(parseToml(unmanaged).mcp_servers)
  if (url !== undefined && existing && HOSTED_MCP_SERVER_NAME in existing) {
    throw new Error(`Codex config ${file} already defines claxedo outside the managed block; remove that entry before installing`)
  }
  const managed = url === undefined ? "" : [
    CODEX_BLOCK_START,
    `[mcp_servers.${HOSTED_MCP_SERVER_NAME}]`,
    `url = ${JSON.stringify(url)}`,
    CODEX_BLOCK_END,
  ].join("\n")
  const next = [unmanaged, managed].filter(Boolean).join("\n\n")
  const contents = next ? `${next}\n` : ""
  if (contents === current) return { state: "unchanged" }
  return { contents, state: url === undefined ? "removed" : "written" }
}

async function applyAll(url: string | undefined, paths: HostedMcpInstallPaths, env: NodeJS.ProcessEnv) {
  const target = harnessConfigFiles(paths, env)
  const changes: Array<HostedMcpInstallResult & { contents?: string }> = []
  for (const harness of ["claude", "cursor", "codex"] as const) {
    const file = target[harness]
    const change = harness === "codex"
      ? await prepareCodexConfig(file, url)
      : await prepareJsonConfig(file, url)
    changes.push({ harness, file, ...change })
  }
  for (const change of changes) {
    if (change.contents !== undefined) await replaceFileAtomically(change.file, change.contents)
  }
  return changes.map(({ harness, file, state }) => ({ harness, file, state }))
}

/** Writes the hosted `claxedo` entry into Claude Code, Cursor and Codex on this machine. */
export async function installHostedMcpEntry(input: {
  controlPlaneUrl: string
  paths?: HostedMcpInstallPaths
  env?: NodeJS.ProcessEnv
}) {
  const url = hostedMcpUrl(input.controlPlaneUrl)
  return { url, results: await applyAll(url, input.paths ?? {}, input.env ?? process.env) }
}

/** Removes the entry this module wrote, leaving every other server alone. */
export async function removeHostedMcpEntry(input: {
  paths?: HostedMcpInstallPaths
  env?: NodeJS.ProcessEnv
} = {}) {
  return { results: await applyAll(undefined, input.paths ?? {}, input.env ?? process.env) }
}
