/**
 * Centralized Agent Configuration
 *
 * Stores trusted operator configuration for agent runtimes:
 *   - User MCP servers
 *   - Slash commands (markdown files in ~/.claxedo/commands/)
 *
 * Command .md files at:     ~/.claxedo/commands/<name>.md
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { SandboxDriverConfig } from "@claxedo/sandbox-contract"
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
} from "./connections"
import type {
  ConnectionProvider,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
} from "@claxedo/agent-sdk-runtime"
import { createAcpConnectionProvider, createConnectionProviderRegistry } from "@claxedo/agent-sdk-runtime"
import type { ProviderProjectionSource, RuntimeHarnessSelection } from "@claxedo/workspace-runtime/config"

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
import type { SandboxSecretBrokering } from "../credentials/native-delivery"
import { invalidSchema, sandboxDriverConfig, validateUserAgentConfig, type UserAgentConfig } from "./config"
import { sqliteUserAgentConfigRepository } from "./sqlite-repository"
export { sandboxDriverConfig } from "./config"
export type { UserAgentConfig, UserMcpServer } from "./config"
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

// ── Types ──────────────────────────────────────────────────────────────────

export interface RuntimeConfigSnapshot {
  version: 4
  mcp: Record<string, ResolvedMcpServer>
  connections: HarnessConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
  /** Broker endpoints and placeholders; the credential values stay with the authority. */
  auth: Record<string, ProviderProjectionSource>
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
    /** How this workspace's sandbox can carry a credential, when it has one. */
    secretBrokering?: SandboxSecretBrokering
  }) => Promise<Record<string, ProviderProjectionSource>>
}

let agentConfigOptions: AgentConfigOptions = {}

/** Release process-owned agent configuration and its lazily opened resources. */
export function disposeAgentConfig() {
  agentConfigOptions = {}
  harnessConnectionSchema = createHarnessConnectionSchema()
}

/**
 * The credential authority this composition installed, for a consumer whose
 * credentials do not travel in a runtime snapshot. Answers nothing when no
 * authority is installed, which means every harness runs on its machine's login.
 */
export function projectRuntimeAuth(input: {
  scope: RuntimeConfigSecretScope
  orgId?: string
  workspaceId?: string
  secretBrokering?: SandboxSecretBrokering
}): Promise<Record<string, ProviderProjectionSource>> {
  return agentConfigOptions.projectAuth?.(input) ?? Promise.resolve({})
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

const LOCAL_CONFIG_ID = "__local__"

export async function loadUserConfig(): Promise<UserAgentConfig> {
  return sqliteUserAgentConfigRepository(harnessConnectionSchema).read(LOCAL_CONFIG_ID)
}

export async function saveUserConfig(config: UserAgentConfig): Promise<void> {
  const next = validateUserAgentConfig(config, harnessConnectionSchema)
  const previous = await loadUserConfig()
  const revisionProblems = connectionRevisionProblems(previous.connections, next.connections)
  if (revisionProblems.length > 0) {
    throw invalidSchema(revisionProblems.map((problem) => `${problem.connectionId}: ${problem.problem}`).join("; "))
  }
  await sqliteUserAgentConfigRepository(harnessConnectionSchema).write(LOCAL_CONFIG_ID, next)
  log.info("Saved user agent config", {
    mcpServers: Object.keys(next.mcp),
    connections: Object.keys(next.connections),
  })
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
    secretBrokering?: SandboxSecretBrokering
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
  const auth = await agentConfigOptions.projectAuth?.({
    scope,
    ...(options.orgId ? { orgId: options.orgId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.secretBrokering ? { secretBrokering: options.secretBrokering } : {}),
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
