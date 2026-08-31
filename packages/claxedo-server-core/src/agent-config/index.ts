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
import { resolveSecretsForScope } from "@claxedo/server-core/credentials/registry"
import {
  getRuntimeAgentExtensionsSnapshot,
  resolveProjectExtensionTrust,
  type AgentExtensionPolicyOverride,
  type RuntimeAgentExtensionsSnapshot,
} from "../hosts/agent-extensions/runtime-config"
import {
  readMirroredWorkspaceAgentExtensions,
  sameSource,
  workspaceAgentExtensionRecords,
  type WorkspaceAgentExtensionRecord,
} from "../hosts/agent-extensions/workspace"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { createSqliteWorkspaceAuthority } from "../authority/adapters/sqlite/workspace-authority"
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
import type { RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"

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
  version: 3
  mcp: Record<string, ResolvedMcpServer>
  connections: HarnessConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
  auth: Record<string, string>
  agent_extensions?: RuntimeAgentExtensionsSnapshot
}

export type RuntimeConfigSecretScope = "local" | "shared"
type RuntimeWorkspaceAuthority = Pick<
  WorkspaceAuthority,
  "listWorkspaceAgentExtensionsForRuntime" | "listAgentExtensionPolicyOverridesForRuntime"
>

export interface CommandItem {
  name: string
  content: string
}

export type AgentConfigOptions = {
  /**
   * Authority used to hydrate workspace Agent Extensions into the runtime
   * snapshot pushed to sandboxes.
   *
   * A composition supplies its canonical authority; agent-config does not
   * choose between local and cloud adapters from ambient environment state.
   * When mounted standalone, the local SQLite authority answers.
   */
  workspaceAuthority?: RuntimeWorkspaceAuthority
  /** Providers installed by this product composition. */
  connectionProviders?: readonly ConnectionProvider<unknown, unknown>[]
}

let agentConfigOptions: AgentConfigOptions = {}
let localRuntimeWorkspaceAuthority: {
  dataRoot: string
  authority: ReturnType<typeof createSqliteWorkspaceAuthority>
} | undefined

/** Release process-owned agent configuration and its lazily opened resources. */
export function disposeAgentConfig() {
  localRuntimeWorkspaceAuthority?.authority.close()
  localRuntimeWorkspaceAuthority = undefined
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
  await fs.promises.mkdir(claxedoDir(), { recursive: true, mode: 0o755 })
  const target = userConfigFile()
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
    await fs.promises.rename(temporary, target)
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => undefined)
    throw error
  }
  log.info("Saved user agent config", {
    mcpServers: Object.keys(next.mcp),
    connections: Object.keys(next.connections),
  })
}

function emptyUserAgentConfig(): UserAgentConfig {
  return { version: 3, mcp: {}, connections: {}, auth: {}, sandbox_driver: {} }
}

function validateUserAgentConfig(input: unknown): UserAgentConfig {
  const row = record(input)
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
  const mcp = record(row.mcp)
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
  const row = record(input)
  if (!row || row.kind !== "native" || typeof row.harnessId !== "string" || !isNativeHarnessId(row.harnessId)) return
  if (Object.keys(row).some((key) => key !== "kind" && key !== "harnessId")) return
  return { kind: "native", harnessId: row.harnessId }
}

function mcpEntries(input: Record<string, unknown>): Record<string, UserMcpServer> {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => {
    const row = record(value)
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

// Default workspace authority for RUNTIME snapshot hydration (sandbox
// provisioning / broadcast config pushes). The composition supplies the
// authority it already selected; otherwise the local SQLite authority answers.
function defaultRuntimeWorkspaceAuthority(): RuntimeWorkspaceAuthority {
  if (agentConfigOptions.workspaceAuthority) return agentConfigOptions.workspaceAuthority
  // Memoized per data root so repeated config pushes reuse one SQLite
  // connection (same authority.db file the server composition opens).
  const dataRoot = dataDir()
  if (localRuntimeWorkspaceAuthority?.dataRoot !== dataRoot) {
    localRuntimeWorkspaceAuthority = { dataRoot, authority: createSqliteWorkspaceAuthority() }
  }
  return localRuntimeWorkspaceAuthority.authority
}

// Authority-less mounts (routes composed without control-plane services)
// record workspace Agent Extensions in the local mirror instead of an
// authority. Fold those records in so a sandbox re-provision does not lose
// extensions that only the live `syncWorkspaceRuntimeAgentExtensions` push
// knew about. Authority records win on id conflicts — and on source
// conflicts, because a same-source record under another id (legacy
// manifest-derived vs catalog id) is the same install and would replay onto
// the same package_name-derived artifact paths.
async function mirroredRuntimeWorkspaceAgentExtensions(workspaceId: string) {
  try {
    return await readMirroredWorkspaceAgentExtensions({ workspaceId })
  } catch {
    return []
  }
}

function mergeWorkspaceAgentExtensionRecords(
  primary: WorkspaceAgentExtensionRecord[],
  fallback: WorkspaceAgentExtensionRecord[],
) {
  const seen = new Set(primary.map((item) => item.desired.id))
  return [...primary, ...fallback.filter((item) =>
    !seen.has(item.desired.id)
    && !primary.some((record) => sameSource(record.desired.source, item.desired.source)))]
}

async function runtimeWorkspaceAgentExtensions(workspaceId: string, input: {
  required: boolean
  authority?: RuntimeWorkspaceAuthority
}) {
  try {
    const records = workspaceAgentExtensionRecords(await (input.authority ?? defaultRuntimeWorkspaceAuthority()).listWorkspaceAgentExtensionsForRuntime({
      workspaceId,
    }))
    return mergeWorkspaceAgentExtensionRecords(records, await mirroredRuntimeWorkspaceAgentExtensions(workspaceId))
  } catch (err) {
    if (err instanceof ControlPlaneAuthError && err.code === "workspace_authority_unavailable") {
      if (input.required) throw err
      log.warn("Workspace Agent Extensions hydration unavailable; continuing with mirrored runtime installs", {
        workspaceId,
        required: input.required,
        error: err.message,
      })
      const mirrored = await mirroredRuntimeWorkspaceAgentExtensions(workspaceId)
      return mirrored.length > 0 ? mirrored : undefined
    }
    log.warn("Failed to hydrate workspace Agent Extensions from the workspace authority", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

async function runtimeWorkspaceAgentExtensionPolicyOverrides(workspaceId: string, input: {
  required: boolean
  authority?: RuntimeWorkspaceAuthority
}) {
  try {
    return await (input.authority ?? defaultRuntimeWorkspaceAuthority()).listAgentExtensionPolicyOverridesForRuntime({
      workspaceId,
    }) as AgentExtensionPolicyOverride[]
  } catch (err) {
    if (err instanceof ControlPlaneAuthError && err.code === "workspace_authority_unavailable") {
      if (input.required) throw err
      log.warn("Workspace Agent Extension policy hydration unavailable; continuing with empty policy overrides", {
        workspaceId,
        required: input.required,
        error: err.message,
      })
      return undefined
    }
    log.warn("Failed to hydrate workspace Agent Extension policy from the workspace authority", {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
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
  current?: RuntimeHarnessSelection,
  options: {
    secretScope?: RuntimeConfigSecretScope
    workspaceDir?: string
    workspaceId?: string
    workspaceInstalls?: WorkspaceAgentExtensionRecord[]
    policyOverrides?: AgentExtensionPolicyOverride[]
    authority?: RuntimeWorkspaceAuthority
    requireWorkspaceAgentExtensions?: boolean
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
  // Merge trusted config auth with credential registry secrets (registry takes precedence).
  const configAuth = options.secretScope === "shared" ? {} : config.auth ?? {}
  let registryAuth: Record<string, string> = {}
  try {
    registryAuth = await resolveSecretsForScope(scope)
  } catch {
    // Registry may not be initialized yet during early startup
  }
  const auth = { ...configAuth, ...registryAuth }
  const codexAppServerAuth = auth.openai
  if (!auth["codex-app-server"] && codexAppServerAuth) auth["codex-app-server"] = codexAppServerAuth
  const workspaceInstalls = options.workspaceDir && options.workspaceId
    ? options.workspaceInstalls ?? await runtimeWorkspaceAgentExtensions(options.workspaceId, {
        required: options.requireWorkspaceAgentExtensions ?? false,
        authority: options.authority,
      })
    : undefined
  const workspaceAgentExtensions = options.workspaceDir && options.workspaceId
    ? {
        workspaceInstalls: workspaceInstalls ?? [],
        policyOverrides: options.policyOverrides
          ?? await runtimeWorkspaceAgentExtensionPolicyOverrides(options.workspaceId, {
            required: options.requireWorkspaceAgentExtensions ?? false,
            authority: options.authority,
          })
          ?? [],
      }
    : undefined
  return {
    version: 3,
    mcp,
    connections: Object.values(config.connections),
    ...(selected ? { defaultHarness: selected } : {}),
    auth,
    ...(options.workspaceDir ? { agent_extensions: await getRuntimeAgentExtensionsSnapshot({
      projectDir: options.workspaceDir,
    }, {
      ...(workspaceAgentExtensions ?? {}),
      // The checkout is repo-controlled input: its extension declarations
      // apply only as far as this host's consent ledger currently vouches —
      // per install id, plus an explicit first-party flag (see
      // @claxedo/agent-extensions trust). Drifted or unconsented declarations
      // contribute nothing; control-plane workspace installs above are
      // unaffected.
      projectStateTrusted: await resolveProjectExtensionTrust({
        dataRoot: claxedoDir(),
        projectDir: options.workspaceDir,
      }),
    }) } : {}),
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
