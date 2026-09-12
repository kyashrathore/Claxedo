/**
 * Centralized Agent Configuration
 *
 * Stores trusted operator configuration for agent runtimes:
 *   - User MCP servers
 *   - Slash commands (markdown files in ~/.claxedo/commands/)
 *
 * User config persisted at: ~/.claxedo/user-agent-config.json
 * Command .md files at:     ~/.claxedo/commands/<name>.md
 */

import { asRecord } from "@claxedo/helpers/guards"
import * as fs from "fs"
import * as path from "path"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { isSandboxDriverID, type SandboxDriverConfig } from "@claxedo/sandbox-contract"
import {
  loadManagedMcpState,
  harnessAgent,
  resolveEffectiveMcp,
  resolveUserMcp,
  type ResolvedMcpServer,
} from "@claxedo/workspace-runtime/config"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
  isConnectionId,
  isNativeHarnessId,
} from "./connections"
import type {
  ConnectionProvider,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "@claxedo/agent-sdk-runtime"
import { createAcpConnectionProvider, createConnectionProviderRegistry } from "@claxedo/agent-sdk-runtime"
import type { ProviderProjection, RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"

export type {
  ConnectionReadiness,
  HarnessConnectionCapabilities,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "@claxedo/agent-sdk-runtime"
export type {
  RuntimeHarnessSelection,
  RuntimeNativeHarnessId,
} from "@claxedo/workspace-runtime/config"
export {
  explicitDefaultHarness,
  isConnectionId,
  isNativeHarnessId,
} from "./connections"
export {
  ConnectionUnavailableError,
  createLocalConnectionSecretResolver,
  createVmConnectionSecretResolver,
  publicConnectionUnavailable,
} from "./connection-secrets"
import { jsonStringRecord } from "@claxedo/server-core/platform/runtime/lib/json"
export type {
  ConnectionSecretUnavailableReason,
  PublicConnectionUnavailable,
} from "./connection-secrets"
export type {
  ConnectionSecretLease,
  ConnectionSecretResolver,
} from "@claxedo/agent-sdk-runtime"

const log = Log.create({ service: "agent-config" })

function claxedoDir() {
  return dataDir()
}

function commandDir() {
  return path.join(claxedoDir(), "commands")
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

export interface UserAgentConfig {
  version: 3
  mcp: Record<string, UserMcpServer>
  connections: Record<string, HarnessConnectionDescriptor>
  /** Explicit operator policy. Omission leaves agent selection unresolved. */
  defaultConnectionId?: string
  /** Explicit native default; mutually exclusive with defaultConnectionId. */
  defaultHarness?: Extract<RuntimeHarnessSelection, { kind: "native" }>
  auth?: Record<string, string>  // native provider ID → credential material
  sandbox_driver?: SandboxDriverConfig
}

class UserAgentConfigLoadError extends Error {
  constructor(
    readonly code: "user_agent_config_read_failed" | "user_agent_config_invalid_json" | "user_agent_config_invalid_schema",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "UserAgentConfigLoadError"
  }
}

export interface RuntimeConfigSnapshot {
  version: 4
  mcp: Record<string, ResolvedMcpServer>
  connections: HarnessConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
  /** Broker endpoints and placeholders; the credential values stay with the authority. */
  auth: Record<string, ProviderProjection>
  /** Opaque per-harness launch options contributed by the product composition. */
  harnessLaunch?: Record<string, Record<string, unknown>>
}

export type RuntimeConfigSecretScope = "local" | "shared"

export interface CommandItem {
  name: string
  content: string
}

export type AgentConfigOptions = {
  /** Providers installed by this product composition. */
  connectionProviders?: readonly ConnectionProvider<unknown, unknown>[]
  /**
   * Opaque per-harness launch options an optional product module (Agent
   * Plugins) projects into every runtime snapshot. Read on each snapshot so
   * a re-projection after activation reaches the next config push.
   */
  harnessLaunch?: () => Promise<Record<string, Record<string, unknown>>>
  /**
   * The credential authority that turns this host's active accounts into
   * broker-backed projections. A composition that installs none sends no
   * credentials, and every harness runs on whatever login its own machine holds.
   */
  projectAuth?: (input: {
    scope: RuntimeConfigSecretScope
    orgId?: string
    workspaceId?: string
  }) => Promise<Record<string, ProviderProjection>>
}

let agentConfigOptions: AgentConfigOptions = {}

/** Release process-owned agent configuration and its lazily opened resources. */
export function disposeAgentConfig() {
  agentConfigOptions = {}
  harnessConnectionSchema = createHarnessConnectionSchema()
}

export function configureAgentConfig(options: AgentConfigOptions = {}) {
  disposeAgentConfig()
  agentConfigOptions = options
  harnessConnectionSchema = createHarnessConnectionSchema(createConnectionProviderRegistry(
    options.connectionProviders ?? [createAcpConnectionProvider()],
  ))
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

const stringRecord = jsonStringRecord

// ── Trusted generic connections ───────────────────────────────────────────

let harnessConnectionSchema = createHarnessConnectionSchema()

export function validateHarnessConnections(input: unknown) {
  return harnessConnectionSchema.validate(input)
}

export function publicHarnessConnections(
  connections: Record<string, HarnessConnectionDescriptor>,
) {
  return harnessConnectionSchema.publicRows(connections)
}

export function connectionRevisionProblems(
  previous: Record<string, HarnessConnectionDescriptor>,
  next: Record<string, HarnessConnectionDescriptor>,
) {
  return harnessConnectionSchema.revisionProblems(previous, next)
}

export function harnessConnectionRows(
  config: Pick<UserAgentConfig, "connections">,
): HarnessConnectionRef[] {
  return publicHarnessConnections(config.connections)
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
  if (raw === undefined) return emptyUserAgentConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UserAgentConfigLoadError(
      "user_agent_config_invalid_json",
      "User agent config contains invalid JSON",
    )
  }
  const row = asRecord(parsed)
  const legacyVersion = row ? legacyConfigVersion(row) : undefined
  if (row && legacyVersion !== undefined) return migrateLegacyUserConfig(row, raw, legacyVersion)
  return validateUserAgentConfig(parsed)
}

function isNodeError(error: unknown, code: string) {
  return !!error && typeof error === "object" && "code" in error && error.code === code
}

export async function saveUserConfig(config: UserAgentConfig): Promise<void> {
  const next = validateUserAgentConfig(config)
  const previous = await loadUserConfig()
  const revisionProblems = connectionRevisionProblems(previous.connections, next.connections)
  if (revisionProblems.length > 0) {
    throw invalidSchema(revisionProblems.map((problem) => `${problem.connectionId}: ${problem.problem}`).join("; "))
  }
  await writeUserConfigFile(next)
  log.info("Saved user agent config", {
    mcpServers: Object.keys(next.mcp),
    connections: Object.keys(next.connections),
  })
}

async function writeUserConfigFile(config: UserAgentConfig): Promise<void> {
  await fs.promises.mkdir(claxedoDir(), { recursive: true, mode: 0o755 })
  const target = userConfigFile()
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    await fs.promises.rename(temporary, target)
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined)
    throw error
  }
}

// ── Forward migration of pre-v3 files ──────────────────────────────────────

/**
 * The legacy schema version a file is written in, or undefined when it is not
 * legacy. The v2-era loader persisted no `version` field at all, so a file
 * without one is a v2 file.
 */
function legacyConfigVersion(row: Record<string, unknown>): number | undefined {
  if (row.version === undefined) return 2
  if (row.version === 1 || row.version === 2) return row.version
  return undefined
}

async function migrateLegacyUserConfig(
  row: Record<string, unknown>,
  raw: string,
  legacyVersion: number,
): Promise<UserAgentConfig> {
  const defaultHarness = legacyNativeDefault(row.harness)
  const migrated = validateUserAgentConfig({
    version: 3,
    mcp: row.mcp ?? {},
    connections: {},
    ...(defaultHarness ? { defaultHarness } : {}),
    auth: row.auth ?? {},
    sandbox_driver: row.sandbox_driver,
  })
  const carried = new Set(["version", "mcp", "auth", "sandbox_driver", ...(defaultHarness ? ["harness"] : [])])
  const dropped = Object.keys(row).filter((key) => !carried.has(key))

  const backup = path.join(claxedoDir(), `user-agent-config.legacy-v${legacyVersion}.json`)
  await fs.promises.writeFile(backup, raw, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
    if (isNodeError(error, "EEXIST")) return
    throw error
  })
  await writeUserConfigFile(migrated)

  log.info("Migrated user agent config to v3", {
    from: legacyVersion,
    backup,
    defaultHarness: migrated.defaultHarness?.harnessId,
  })
  if (dropped.length > 0) {
    log.warn("Dropped legacy user agent config fields with no v3 equivalent", {
      dropped,
      backup,
    })
  }
  return migrated
}

/**
 * A legacy `harness` survives only as an explicit native selection. Legacy ACP
 * identities carry a bare command, not the provider-validated descriptor a v3
 * connection requires, so they are dropped rather than half-translated.
 */
function legacyNativeDefault(input: unknown): Extract<RuntimeHarnessSelection, { kind: "native" }> | undefined {
  const row = asRecord(input)
  if (!row || row.access !== "native" || typeof row.id !== "string" || !isNativeHarnessId(row.id)) return undefined
  return { kind: "native", harnessId: row.id }
}

function emptyUserAgentConfig(): UserAgentConfig {
  return { version: 3, mcp: {}, connections: {}, auth: {}, sandbox_driver: {} }
}

function validateUserAgentConfig(input: unknown): UserAgentConfig {
  const row = asRecord(input)
  if (!row || row.version !== 3) throw invalidSchema("version must be exactly 3")
  const allowed = new Set([
    "version",
    "mcp",
    "connections",
    "defaultConnectionId",
    "defaultHarness",
    "auth",
    "sandbox_driver",
  ])
  const unsupported = Object.keys(row).find((key) => !allowed.has(key))
  if (unsupported) throw invalidSchema(`unsupported field: ${unsupported}`)
  const mcp = asRecord(row.mcp)
  if (!mcp) throw invalidSchema("mcp must be an object map")
  const connections = validateHarnessConnections(row.connections)
  if (connections.problems.length > 0) {
    throw invalidSchema(connections.problems.map((problem) =>
      `${problem.connectionId || "connections"}: ${problem.problem}`).join("; "))
  }
  const auth = row.auth === undefined ? {} : stringRecord(row.auth)
  if (!auth) throw invalidSchema("auth must be a string map")
  const defaultConnectionId = row.defaultConnectionId
  if (defaultConnectionId !== undefined && (typeof defaultConnectionId !== "string" || !isConnectionId(defaultConnectionId))) {
    throw invalidSchema("defaultConnectionId must be a valid connection id")
  }
  const defaultHarness = validateNativeDefault(row.defaultHarness)
  if (row.defaultHarness !== undefined && !defaultHarness) {
    throw invalidSchema("defaultHarness must be an explicit supported native selection")
  }
  if (defaultConnectionId && defaultHarness) {
    throw invalidSchema("defaultConnectionId and defaultHarness are mutually exclusive")
  }
  if (defaultConnectionId) {
    const connection = connections.accepted[defaultConnectionId]
    if (!connection) throw invalidSchema("defaultConnectionId must name an installed connection")
    if (!connection.enabled) throw invalidSchema("defaultConnectionId must name an enabled connection")
  }
  return {
    version: 3,
    mcp: mcpEntries(mcp),
    connections: connections.accepted,
    ...(defaultConnectionId ? { defaultConnectionId } : {}),
    ...(defaultHarness ? { defaultHarness } : {}),
    auth,
    sandbox_driver: sandboxDriverConfig({ sandbox_driver: row.sandbox_driver }),
  }
}

function validateNativeDefault(input: unknown): Extract<RuntimeHarnessSelection, { kind: "native" }> | undefined {
  const row = asRecord(input)
  if (!row || row.kind !== "native" || typeof row.harnessId !== "string" || !isNativeHarnessId(row.harnessId))
    return undefined
  if (Object.keys(row).some((key) => key !== "kind" && key !== "harnessId")) return undefined
  return { kind: "native", harnessId: row.harnessId }
}

function mcpEntries(input: Record<string, unknown>): Record<string, UserMcpServer> {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    const row = asRecord(value)
    if (!row || (row.type !== "stdio" && row.type !== "remote")) return []
    return [[key, {
      type: row.type,
      ...(typeof row.command === "string" ? { command: row.command } : {}),
      ...(Array.isArray(row.args) && row.args.every((arg) => typeof arg === "string") ? { args: [...row.args] } : {}),
      ...(stringRecord(row.env) ? { env: stringRecord(row.env) } : {}),
      ...(typeof row.url === "string" ? { url: row.url } : {}),
      ...(stringRecord(row.headers) ? { headers: stringRecord(row.headers) } : {}),
      ...(typeof row.disabled === "boolean" ? { disabled: row.disabled } : {}),
    } satisfies UserMcpServer]]
  }))
}

function invalidSchema(detail: string) {
  return new UserAgentConfigLoadError(
    "user_agent_config_invalid_schema",
    `User agent config does not match schema v3: ${detail}`,
  )
}

export function sandboxDriverConfig(
  config?: { sandbox_driver?: unknown },
): SandboxDriverConfig {
  const row = asRecord(config?.sandbox_driver)
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
  const row = asRecord(input)
  if (!row) return undefined

  const auth: NonNullable<SandboxDriverConfig["auth"]> = {}
  const daytona = asRecord(row.daytona)
  const modal = asRecord(row.modal)
  const vercel = asRecord(row.vercel)
  const cloudflare = asRecord(row.cloudflare)
  const docker = asRecord(row.docker)
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

function credential(row: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = row?.[key]
  if (typeof value !== "string") return undefined
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
): RuntimeHarnessSelection | undefined {
  return config ? explicitDefaultHarness(config) : undefined
}

async function runtimeMcp(
  config: UserAgentConfig,
  harness: RuntimeHarnessSelection | undefined,
  scope: RuntimeConfigSecretScope,
) {
  const userMcp = scope === "shared" ? {} : config.mcp
  if (!harness) return resolveUserMcp(userMcp)
  if (harness.kind === "connection") return resolveUserMcp(userMcp)
  const agent = harnessAgent(harness.harnessId)
  if (!agent) return resolveUserMcp(userMcp)
  const state = await loadManagedMcpState()
  return resolveEffectiveMcp({
    state,
    agent,
    control: "managed",
    userMcp,
    strict: true,
  }).mcp
}

export async function getRuntimeConfigSnapshot(
  current?: RuntimeHarnessSelection,
  options: {
    secretScope?: RuntimeConfigSecretScope
    orgId?: string
    workspaceDir?: string
    workspaceId?: string
  } = {},
): Promise<RuntimeConfigSnapshot> {
  const config = await loadUserConfig()
  const selected = current ?? defaultHarness(config)
  if (selected?.kind === "connection") {
    const connection = config.connections[selected.connectionId]
    if (!connection || !connection.enabled) {
      throw invalidSchema("selected connection is not installed and enabled")
    }
  }
  const scope = options.secretScope ?? "local"
  const mcp = await runtimeMcp(config, selected, scope)
  // A shared-scope sandbox reaches its credentials through its own provider's
  // edge, which no authority here can mint; that adapter is the next slice.
  const auth = scope === "shared"
    ? {}
    : await agentConfigOptions.projectAuth?.({
      scope,
      ...(options.orgId ? { orgId: options.orgId } : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    }) ?? {}
  const harnessLaunch = await agentConfigOptions.harnessLaunch?.()
  return {
    version: 4,
    mcp,
    connections: Object.values(config.connections),
    ...(selected ? { defaultHarness: selected } : {}),
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

/** Returns the canonical provider-neutral runtime configuration snapshot. */
export async function getEffectiveConfig(): Promise<Record<string, unknown>> {
  return { ...await getRuntimeConfigSnapshot() }
}
