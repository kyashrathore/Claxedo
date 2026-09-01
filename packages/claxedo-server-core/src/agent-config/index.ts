/**
 * Centralized Agent Configuration
 *
 * Stores user-defined additions to the opencode agent config:
 *   - User MCP servers
 *   - Slash commands (markdown files in ~/.claxedo/opencode-config/command/)
 *
 * User config persisted at: ~/.claxedo/user-agent-config.json
 * Command .md files at:     ~/.claxedo/opencode-config/command/<name>.md
 *
 * The opencode wrapper sets OPENCODE_CONFIG_DIR=~/.claxedo/opencode-config/,
 * so opencode automatically picks up both the opencode.jsonc (MCP) and the
 * command/ directory (slash commands) on every startup.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { isSandboxDriverID, type SandboxDriverConfig } from "@claxedo/sandbox-contract"
import {
  harnessKey,
  isAcpConnectionId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  type AgentHarnessId,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import {
  loadManagedMcpState,
  harnessAgent,
  mcpControl,
  resolveEffectiveMcp,
  resolveUserMcp,
  toOpencodeConfig,
  type ResolvedMcpServer,
} from "@claxedo/workspace-runtime/config"
import { resolveSecretsForScope } from "@claxedo/server-core/credentials/registry"

const log = Log.create({ service: "agent-config" })

function claxedoDir() {
  return dataDir()
}

function commandDir() {
  return path.join(claxedoDir(), "opencode-config", "command")
}

function userConfigFile() {
  return path.join(claxedoDir(), "user-agent-config.json")
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface UserMcpServer {
  /** "stdio" spawns a local subprocess; "remote" connects to an HTTP/SSE endpoint */
  type: "stdio" | "remote"
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // remote
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

/**
 * One operator-configured ACP connection: a stdio ACP-compatible agent the
 * operator installed themselves, described as data in the trusted config.
 * The map of these IS the extension catalog, execution allowlist, and source
 * of runtime descriptors — there is no second registry.
 */
export interface UserAcpConnection {
  label: string
  /** `command[0]` is the executable; remaining values are arguments. */
  command: string[]
  /** Extra process environment applied over the runtime environment. */
  env?: Record<string, string>
  /** Narrow generic-ACP compatibility switches (only proven-necessary ones). */
  params?: { supportsMcpServers?: boolean }
  /** Defaults to true. `false` is an explicit, reversible disable. */
  enabled?: boolean
}

export interface UserAgentConfig {
  mcp: Record<string, UserMcpServer>
  harness?: SessionHarness
  model?: string
  runner?: unknown
  auth?: Record<string, string>  // native provider ID → credential material
  sandbox_driver?: SandboxDriverConfig
  /** Operator-configured ACP connections, keyed by stable lowercase slug. */
  acp?: Record<string, UserAcpConnection>
}

class UserAgentConfigLoadError extends Error {
  constructor(
    readonly code: "user_agent_config_read_failed" | "user_agent_config_invalid_json",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "UserAgentConfigLoadError"
  }
}

export interface RuntimeConfigSnapshot {
  version: 2
  mcp: Record<string, ResolvedMcpServer>
  harnesses: NonNullable<UserAgentConfig["harness"]>[]
  auth: Record<string, string>
  /** Opaque per-harness launch options contributed by the product composition. */
  harnessLaunch?: Record<string, Record<string, unknown>>
}

export type RuntimeConfigSecretScope = "local" | "shared"

export interface CommandItem {
  name: string
  content: string
}

export type HarnessType = AgentHarnessId
export type AgentConfigOptions = {
  /**
   * Per-harness launch options contributed by the product composition.
   *
   * A composition supplies the projection; agent-config does not reach for a
   * workspace authority of its own, and does not choose between local and
   * cloud adapters from ambient environment state.
   */
  harnessLaunch?: () => Promise<Record<string, Record<string, unknown>>>
}

let agentConfigOptions: AgentConfigOptions = {}

/** Release process-owned agent configuration and its lazily opened resources. */
export function disposeAgentConfig() {
  agentConfigOptions = {}
}

export function configureAgentConfig(options: AgentConfigOptions = {}) {
  disposeAgentConfig()
  agentConfigOptions = options
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

function stringRecord(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    && Object.values(input).every((item) => typeof item === "string")
    ? input as Record<string, string>
    : undefined
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

// ── Operator ACP connections ───────────────────────────────────────────────

export type AcpConnectionProblem = { id: string; problem: string }

/**
 * Validates a proposed ACP connection map in full. Mutation paths reject when
 * any problem is reported (one malformed entry rejects the whole mutation);
 * the load path keeps only `accepted` and logs what it dropped, so a hand
 * -edited file with one typo cannot take the server down.
 */
export function normalizeAcpConnections(input: unknown): {
  accepted: Record<string, UserAcpConnection>
  problems: AcpConnectionProblem[]
} {
  const accepted: Record<string, UserAcpConnection> = {}
  const problems: AcpConnectionProblem[] = []
  const rows = record(input)
  if (input !== undefined && !rows) {
    return { accepted, problems: [{ id: "", problem: "acp must be an object map of connection definitions" }] }
  }
  for (const [id, value] of Object.entries(rows ?? {})) {
    if (!isAcpConnectionId(id)) {
      problems.push({ id, problem: "connection id must be a lowercase slug (a-z, 0-9, dashes; max 64 chars)" })
      continue
    }
    const row = record(value)
    if (!row) {
      problems.push({ id, problem: "connection definition must be an object" })
      continue
    }
    const label = typeof row.label === "string" ? row.label.trim() : ""
    if (!label) {
      problems.push({ id, problem: "label is required" })
      continue
    }
    const command = Array.isArray(row.command) && row.command.length > 0
      && row.command.every((item) => typeof item === "string" && item.trim())
      ? (row.command as string[]).map((item) => item.trim())
      : undefined
    if (!command) {
      problems.push({ id, problem: "command must be a non-empty array of strings (command[0] is the executable)" })
      continue
    }
    const env = row.env === undefined ? undefined : stringRecord(row.env)
    if (row.env !== undefined && !env) {
      problems.push({ id, problem: "env must be a string map" })
      continue
    }
    const params = record(row.params)
    if (row.params !== undefined && !params) {
      problems.push({ id, problem: "params must be an object" })
      continue
    }
    if (params && params.supportsMcpServers !== undefined && typeof params.supportsMcpServers !== "boolean") {
      problems.push({ id, problem: "params.supportsMcpServers must be a boolean" })
      continue
    }
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") {
      problems.push({ id, problem: "enabled must be a boolean" })
      continue
    }
    accepted[id] = {
      label,
      command,
      ...(env && Object.keys(env).length ? { env } : {}),
      ...(params && typeof params.supportsMcpServers === "boolean"
        ? { params: { supportsMcpServers: params.supportsMcpServers } }
        : {}),
      ...(row.enabled === false ? { enabled: false } : {}),
    }
  }
  return { accepted, problems }
}

function acpConnectionEnabled(connection: UserAcpConnection) {
  return connection.enabled !== false
}

/** The trusted runtime descriptor for one accepted ACP connection. */
export function acpConnectionHarness(id: string, connection: UserAcpConnection): SessionHarness {
  const [binary, ...args] = connection.command
  return {
    id,
    access: "acp",
    connection: {
      kind: "process",
      binary: binary!,
      ...(args.length ? { args } : {}),
      ...(connection.env ? { env: connection.env } : {}),
      ...(connection.params?.supportsMcpServers !== undefined
        ? { supportsMcpServers: connection.params.supportsMcpServers }
        : {}),
    },
  }
}

/** Enabled connections projected as trusted runtime harness descriptors. */
export function acpConnectionHarnesses(config: Pick<UserAgentConfig, "acp">): SessionHarness[] {
  return Object.entries(config.acp ?? {})
    .filter(([, connection]) => acpConnectionEnabled(connection))
    .map(([id, connection]) => acpConnectionHarness(id, connection))
}

/**
 * The sanitized discovery projection: what the app may see. Identity, label,
 * access, and enabled state only — never the command or environment.
 */
export function acpConnectionRows(config: Pick<UserAgentConfig, "acp">): Array<{
  key: string
  id: string
  label: string
  access: "acp"
  enabled: boolean
}> {
  return Object.entries(config.acp ?? {}).map(([id, connection]) => ({
    key: `acp:${id}`,
    id,
    label: connection.label,
    access: "acp" as const,
    enabled: acpConnectionEnabled(connection),
  }))
}

function normalizeHarness(input: unknown, options: AgentConfigOptions = agentConfigOptions): SessionHarness | undefined {
  const identity = normalizeHarnessIdentity(input)
  if (!identity) return
  const row = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const existingConnection = row.connection && typeof row.connection === "object" && !Array.isArray(row.connection)
    ? row.connection as SessionHarness["connection"]
    : undefined
  if (existingConnection) {
    return {
      id: identity.id,
      access: identity.access,
      connection: existingConnection,
    }
  }
  const binary = typeof row.binary === "string" ? row.binary : undefined
  const transport = normalizeAgentHarnessTransport(row.transport)
  const url = typeof row.url === "string" ? row.url : undefined
  const headers = stringRecord(row.headers)
  return {
    id: identity.id,
    access: identity.access,
    ...(url || transport || headers
      ? {
          connection: {
            kind: "remote" as const,
            ...(transport ? { transport } : {}),
            ...(url ? { url } : {}),
            ...(headers ? { headers } : {}),
          },
        }
      : binary && identity.id !== "opencode" && identity.id !== "pi"
      ? { connection: { kind: "process" as const, binary } }
      : {}),
  }
}

function legacyHarness(input: unknown, options: AgentConfigOptions = agentConfigOptions): { harness: SessionHarness; model?: string } | undefined {
  const harness = normalizeHarness(input, options)
  if (!harness) return
  const row = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
  return {
    harness,
    ...(typeof row.model === "string" ? { model: row.model } : {}),
  }
}

// ── User config (MCP servers) ──────────────────────────────────────────────

export async function loadUserConfig(): Promise<UserAgentConfig> {
  const raw = await fs.promises.readFile(userConfigFile(), "utf-8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined
    throw new UserAgentConfigLoadError(
      "user_agent_config_read_failed",
      "Failed to read user agent config",
      { cause: error },
    )
  })
  if (raw === undefined) return { mcp: {}, auth: {}, sandbox_driver: {} }

  try {
    const data = JSON.parse(raw) as Partial<UserAgentConfig>
    const legacy = legacyHarness(data.runner)
    const acp = normalizeAcpConnections(data.acp)
    for (const problem of acp.problems) {
      log.warn("Ignoring invalid ACP connection in user agent config", problem)
    }
    return {
      mcp: data.mcp ?? {},
      harness: data.harness ?? legacy?.harness,
      model: typeof data.model === "string" ? data.model : legacy?.model,
      auth: data.auth ?? {},
      sandbox_driver: sandboxDriverConfig(data),
      ...(Object.keys(acp.accepted).length ? { acp: acp.accepted } : {}),
    }
  } catch {
    throw new UserAgentConfigLoadError(
      "user_agent_config_invalid_json",
      "User agent config contains invalid JSON",
    )
  }
}

function isNodeError(error: unknown, code: string) {
  return !!error && typeof error === "object" && "code" in error && error.code === code
}

export async function saveUserConfig(config: UserAgentConfig): Promise<void> {
  await fs.promises.mkdir(claxedoDir(), { recursive: true, mode: 0o755 })
  await fs.promises.writeFile(userConfigFile(), JSON.stringify(config, null, 2) + "\n", { mode: 0o644 })
  log.info("Saved user agent config", { mcpServers: Object.keys(config.mcp) })
}

export function sandboxDriverConfig(
  config?: Pick<UserAgentConfig, "sandbox_driver">,
): SandboxDriverConfig {
  const row = record(config?.sandbox_driver)
  if (!row) return {}
  const defaultDriver = typeof row.default_driver === "string" && isSandboxDriverID(row.default_driver)
    ? row.default_driver
    : undefined
  const auth = sandboxDriverAuthConfig(row.auth)
  return {
    ...(defaultDriver ? { default_driver: defaultDriver } : {}),
    ...(auth ? { auth } : {}),
  }
}

function sandboxDriverAuthConfig(input: unknown): SandboxDriverConfig["auth"] | undefined {
  const row = record(input)
  if (!row) return

  const auth: NonNullable<SandboxDriverConfig["auth"]> = {}
  const daytona = record(row.daytona)
  const modal = record(row.modal)
  const vercel = record(row.vercel)
  const cloudflare = record(row.cloudflare)
  const docker = record(row.docker)
  const daytonaApiKey = credential(daytona, "api_key")
  const modalTokenId = credential(modal, "token_id")
  const modalTokenSecret = credential(modal, "token_secret")
  const vercelAccessToken = credential(vercel, "access_token")
  const vercelTeamId = credential(vercel, "team_id")
  const vercelProjectId = credential(vercel, "project_id")
  const cloudflareApiToken = credential(cloudflare, "api_token")
  const cloudflareWorkerUrl = credential(cloudflare, "worker_url")
  const dockerImage = credential(docker, "image")

  if (daytonaApiKey) auth.daytona = { api_key: daytonaApiKey }
  if (modalTokenId || modalTokenSecret) {
    auth.modal = {
      ...(modalTokenId ? { token_id: modalTokenId } : {}),
      ...(modalTokenSecret ? { token_secret: modalTokenSecret } : {}),
    }
  }
  if (vercelAccessToken || vercelTeamId || vercelProjectId) {
    auth.vercel = {
      ...(vercelAccessToken ? { access_token: vercelAccessToken } : {}),
      ...(vercelTeamId ? { team_id: vercelTeamId } : {}),
      ...(vercelProjectId ? { project_id: vercelProjectId } : {}),
    }
  }
  if (cloudflareApiToken || cloudflareWorkerUrl) {
    auth.cloudflare = {
      ...(cloudflareApiToken ? { api_token: cloudflareApiToken } : {}),
      ...(cloudflareWorkerUrl ? { worker_url: cloudflareWorkerUrl } : {}),
    }
  }
  if (dockerImage) auth.docker = { image: dockerImage }

  return Object.keys(auth).length ? auth : undefined
}

function credential(row: Record<string, unknown> | undefined, key: string) {
  const value = row?.[key]
  if (typeof value !== "string") return
  const txt = value.trim()
  return txt ? txt : undefined
}

export function setSandboxDriverConfig(
  config: UserAgentConfig,
  driverConfig: SandboxDriverConfig,
) {
  config.sandbox_driver = driverConfig
}

export function defaultHarness(
  config?: UserAgentConfig,
  options: AgentConfigOptions = agentConfigOptions,
): NonNullable<UserAgentConfig["harness"]> {
  const harness = config?.harness ? normalizeHarness(config.harness, options) : legacyHarness(config?.runner, options)?.harness
  if (harness) return harness
  return { id: "opencode", access: "native" }
}

async function runtimeMcp(
  config: UserAgentConfig,
  harness: NonNullable<UserAgentConfig["harness"]>,
  scope: RuntimeConfigSecretScope,
) {
  const userMcp = scope === "shared" ? {} : config.mcp
  // An operator-configured ACP connection is not one of the managed-MCP
  // capable built-in agents, but the ACP protocol carries MCP servers
  // natively: it receives the user's configured servers (managed servers stay
  // a built-in-agent concern). The connection's `params.supportsMcpServers:
  // false` withholds the offer at the adapter for agents that reject it.
  if (harness.access === "acp") {
    return resolveUserMcp(userMcp)
  }
  const agent = harnessAgent(harnessKey(harness) ?? harness.id)
  if (!agent) return {}
  const state = await loadManagedMcpState()
  return resolveEffectiveMcp({
    state,
    agent,
    control: harness.id === "opencode" ? mcpControl("opencode", { externalOpencode: true }) : "managed",
    userMcp,
    strict: true,
  }).mcp
}

function codexCompatible(input: string | undefined): input is string {
  if (!input) return false
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    if (typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY) return true
    if (value.type === "codex_auth") return true
    if (
      typeof value.auth_mode === "string"
      && value.tokens
      && typeof value.tokens === "object"
    ) return true
    return false
  } catch {
    return true
  }
}

export async function getRuntimeConfigSnapshot(
  current?: NonNullable<UserAgentConfig["harness"]>,
  options: {
    secretScope?: RuntimeConfigSecretScope
    workspaceDir?: string
    workspaceId?: string
  } = {},
): Promise<RuntimeConfigSnapshot> {
  const config = await loadUserConfig()
  const selected = current ?? defaultHarness(config)
  // An operator-configured ACP identity resolves its process descriptor from
  // the accepted registry at snapshot time — the session record and config
  // carry only the logical identity, so a command/env change applies to the
  // next process start without rewriting either.
  const selectedRegistryEntry = selected.access === "acp"
    ? config.acp?.[selected.id]
    : undefined
  const harness = selectedRegistryEntry && acpConnectionEnabled(selectedRegistryEntry)
    ? acpConnectionHarness(selected.id, selectedRegistryEntry)
    : selected
  const scope = options.secretScope ?? "local"
  const mcp = await runtimeMcp(config, harness, scope)
  // Merge legacy config auth with credential registry secrets (registry takes precedence)
  const legacyAuth = options.secretScope === "shared" ? {} : config.auth ?? {}
  let registryAuth: Record<string, string> = {}
  try {
    registryAuth = await resolveSecretsForScope(scope)
  } catch {
    // Registry may not be initialized yet during early startup
  }
  const auth = { ...legacyAuth, ...registryAuth }
  const harnessLaunch = await agentConfigOptions.harnessLaunch?.()
  const codexAppServerAuth = auth.openai
  if (!auth["codex-app-server"] && codexAppServerAuth) auth["codex-app-server"] = codexAppServerAuth
  return {
    version: 2,
    mcp,
    // The selected/default harness leads (receivers still treat the first row
    // as the active one); every other ENABLED operator ACP connection rides
    // along so workspace runtimes hold the full accepted registry.
    harnesses: [
      harness,
      ...acpConnectionHarnesses(config).filter(
        (row) => !(row.id === harness.id && row.access === harness.access),
      ),
    ],
    auth,
    ...(harnessLaunch && Object.keys(harnessLaunch).length ? { harnessLaunch } : {}),
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

export async function listCommands(): Promise<CommandItem[]> {
  try {
    await fs.promises.mkdir(commandDir(), { recursive: true, mode: 0o755 })
    const files = await fs.promises.readdir(commandDir())
    const commands: CommandItem[] = []
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const name = file.slice(0, -3)
      const content = await fs.promises.readFile(path.join(commandDir(), file), "utf-8")
      commands.push({ name, content })
    }
    return commands
  } catch {
    return []
  }
}

export async function getCommand(name: string): Promise<CommandItem | null> {
  const safe = sanitizeName(name)
  try {
    const content = await fs.promises.readFile(path.join(commandDir(), `${safe}.md`), "utf-8")
    return { name: safe, content }
  } catch {
    return null
  }
}

export async function saveCommand(name: string, content: string): Promise<string> {
  await fs.promises.mkdir(commandDir(), { recursive: true, mode: 0o755 })
  const safe = sanitizeName(name)
  await fs.promises.writeFile(path.join(commandDir(), `${safe}.md`), content, { mode: 0o644 })
  log.info("Saved command", { name: safe })
  return safe
}

export async function deleteCommand(name: string): Promise<boolean> {
  const safe = sanitizeName(name)
  try {
    await fs.promises.unlink(path.join(commandDir(), `${safe}.md`))
    log.info("Deleted command", { name: safe })
    return true
  } catch {
    return false
  }
}

// ── Full config for on-demand injection ───────────────────────────────────

/**
 * Returns the effective opencode config as a plain object, suitable for:
 *   - OPENCODE_CONFIG_CONTENT env var (pass to any opencode instance)
 *   - Display in the claxedo UI
 *
 * Includes user-defined MCP servers.
 */
export async function getEffectiveConfig(): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig()
  const state = await loadManagedMcpState()
  return toOpencodeConfig(resolveEffectiveMcp({
    state,
    agent: "opencode",
    control: "generated-config",
    userMcp: userConfig.mcp,
    strict: true,
  }).mcp)
}
