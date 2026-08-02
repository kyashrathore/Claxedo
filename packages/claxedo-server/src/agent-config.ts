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
import os from "os"
import { Log } from "./lib/log"
import { dataDir } from "./lib/paths"
import { isSandboxDriverID, type SandboxDriverConfig } from "@claxedo/sandbox-manager/driver-catalog"
import {
  bundledAcpBinary,
  harnessKey,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  type AcpHarnessId,
  type AgentHarnessId,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import {
  loadManagedMcpState,
  harnessAgent,
  mcpControl,
  resolveEffectiveMcp,
  toOpencodeConfig,
  type ResolvedMcpServer,
} from "@claxedo/workspace-runtime/config"
import { resolveSecretsForScope } from "./adapters/credentials/registry"
import {
  getRuntimeAgentExtensionsSnapshot,
  type AgentExtensionPolicyOverride,
  type RuntimeAgentExtensionsSnapshot,
} from "./hosts/agent-extensions/runtime-config"
import {
  readMirroredWorkspaceAgentExtensions,
  sameSource,
  workspaceAgentExtensionRecords,
  type WorkspaceAgentExtensionRecord,
} from "./hosts/agent-extensions/workspace"
import { ControlPlaneAuthError } from "./authority/auth"
import type { WorkspaceAuthority } from "./authority/authority"
import { convexAuthorityUrlFromEnv, createConvexAuthority } from "./authority/adapters/convex/authority"
import { createSqliteWorkspaceAuthority } from "./authority/adapters/sqlite/workspace-authority"

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

export interface UserAgentConfig {
  mcp: Record<string, UserMcpServer>
  harness?: SessionHarness
  model?: string
  runner?: unknown
  auth?: Record<string, string>  // providerID → API key, e.g. "claude-acp" → "sk-ant-..."
  sandbox_driver?: SandboxDriverConfig
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

export type HarnessType = AgentHarnessId
export type AgentConfigOptions = {
  acpDir?: string
  platform?: NodeJS.Platform
}

let agentConfigOptions: AgentConfigOptions = {}

export function configureAgentConfig(options: AgentConfigOptions = {}) {
  agentConfigOptions = options
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

function cursorBinary() {
  const bin = path.join(os.homedir(), ".local", "bin")
  const choices = [path.join(bin, "agent"), path.join(bin, "cursor-agent")]
  return choices.find((item) => fs.existsSync(item)) ?? "agent"
}

const ACP_BINARY_NAMES: Record<AcpHarnessId, string | (() => string)> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
  cursor: cursorBinary,
}

function acpBinary(id: AcpHarnessId, options: AgentConfigOptions = agentConfigOptions) {
  const binary = ACP_BINARY_NAMES[id]
  const name = typeof binary === "function" ? binary() : binary
  if (path.isAbsolute(name) || name.includes(path.sep)) return name
  // In packaged Electron app, CLAXEDO_ACP_DIR points to the resources/acp directory
  if (options.acpDir) {
    const bundled = bundledAcpBinary(options.acpDir, name, options.platform)
    if (bundled) return bundled
  }
  return path.resolve(import.meta.dirname, "../../workspace-runtime/node_modules/.bin", name)
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
  const binary = typeof row.binary === "string"
    ? row.binary
    : identity.access === "acp"
    ? acpBinary(identity.id as AcpHarnessId, options)
    : undefined
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
    return {
      mcp: data.mcp ?? {},
      harness: data.harness ?? legacy?.harness,
      model: typeof data.model === "string" ? data.model : legacy?.model,
      auth: data.auth ?? {},
      sandbox_driver: sandboxDriverConfig(data),
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
  const agent = harnessAgent(harnessKey(harness) ?? harness.id)
  if (!agent) return {}
  const state = await loadManagedMcpState()
  return resolveEffectiveMcp({
    state,
    agent,
    control: harness.id === "opencode" ? mcpControl("opencode", { externalOpencode: true }) : "managed",
    userMcp: scope === "shared" ? {} : config.mcp,
    strict: true,
  }).mcp
}

// Default workspace authority for RUNTIME snapshot hydration (sandbox
// provisioning / broadcast config pushes). Mirrors the server composition
// rule (server.ts): Convex when a backend URL is configured, otherwise the
// local SQLite authority — so a self-host deploy (no Convex env) still
// hydrates workspace Agent Extensions into the snapshot pushed to sandboxes
// instead of silently pushing an empty install set.
let localRuntimeWorkspaceAuthority: { dataRoot: string; authority: RuntimeWorkspaceAuthority } | undefined
function defaultRuntimeWorkspaceAuthority(): RuntimeWorkspaceAuthority {
  if (convexAuthorityUrlFromEnv(process.env)) return createConvexAuthority()
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
  current?: NonNullable<UserAgentConfig["harness"]>,
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
  const harness = current ?? defaultHarness(config)
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
  const openaiAuth = auth.openai
  const codexAuth = auth["codex-acp"]
  if (!codexAuth && codexCompatible(openaiAuth)) auth["codex-acp"] = openaiAuth
  if (!openaiAuth && codexAuth) auth.openai = codexAuth
  if (!auth["claude-sdk"] && auth["claude-acp"]) auth["claude-sdk"] = auth["claude-acp"]
  const codexAppServerAuth = auth["codex-acp"] ?? auth.openai
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
    version: 2,
    mcp,
    harnesses: [harness],
    auth,
    ...(options.workspaceDir ? { agent_extensions: await getRuntimeAgentExtensionsSnapshot({
      projectDir: options.workspaceDir,
    }, {
      ...(workspaceAgentExtensions ?? {}),
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
