/**
 * Centralized Agent Configuration
 *
 * Stores trusted operator configuration for agent runtimes:
 *   - Slash commands (markdown files in ~/.claxedo/commands/)
 *
 * Command .md files at:     ~/.claxedo/commands/<name>.md
 */

import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import * as fs from "fs"
import * as path from "path"
import { isMissingFile } from "@claxedo/helpers/guards"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { SandboxDriverConfig } from "@claxedo/sandbox-contract"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
  snapshotDefaultHarness,
  type ConnectionConfigHooks,
  type HarnessConnectionDescriptor,
  type HarnessConnectionRef,
} from "./connections"
import type { RuntimeHarnessSelection, RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import type { AcpRuntimeMcpServer } from "../agent-plugins/runtime/mcp-projection"
import type { CustomProviderDefinition } from "@claxedo/harness/contract"
import { listCustomProviders } from "../credentials/custom-provider"

export type {
  ConnectionReadiness,
  HarnessConnectionCapabilities,
  HarnessConnectionRef,
} from "@claxedo/agent-runtime-contract"
export type { ConnectionConfigHooks, HarnessConnectionDescriptor } from "./connections"
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
export type { UserAgentConfig } from "./config"
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
  providerDefinitions?: readonly CustomProviderDefinition[]
  version: 4
  /** The MCP servers active plugins deliver to every custom ACP connection. */
  mcp: Record<string, AcpRuntimeMcpServer>
  connections: HarnessConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
  /** Broker endpoints and placeholders; the credential values stay with the authority. */
  auth: CredentialSnapshot
  commands: CommandItem[]
  /** Opaque per-harness launch options contributed by the product composition. */
  harnessLaunch?: Record<string, Record<string, unknown>>
}

export type RuntimeConfigSecretScope = "local" | "shared"

/** What Agent Plugins contributes to a runtime snapshot: native launch rows and the ACP MCP map. */
export type AgentPluginRuntimeContribution = {
  harnessLaunch: Record<string, Record<string, unknown>>
  mcp: Record<string, AcpRuntimeMcpServer>
}

export interface CommandItem {
  name: string
  content: string
}

export type AgentConfigOptions = {
  /** The connection providers whose descriptors this composition accepts; the ACP provider alone when absent. */
  connectionConfigs?: readonly ConnectionConfigHooks<unknown>[]
  /**
   * The Agent Plugins module's contribution, read on each snapshot so a
   * re-projection after activation reaches the next config push.
   */
  pluginRuntime?: () => Promise<AgentPluginRuntimeContribution>
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
    /** The person a shared-scope sandbox serves; only their accounts and the team's reach it. */
    sandboxOwner?: string
  }) => Promise<CredentialSnapshot>
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
}): Promise<CredentialSnapshot> {
  return agentConfigOptions.projectAuth?.(input) ?? Promise.resolve({ machineOwnerUserId: "", accounts: {} })
}

export function configureAgentConfig(options: AgentConfigOptions = {}) {
  disposeAgentConfig()
  agentConfigOptions = options
  harnessConnectionSchema = createHarnessConnectionSchema(options.connectionConfigs)
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

export async function getRuntimeConfigSnapshot(
  options: {
    secretScope?: RuntimeConfigSecretScope
    orgId?: string
    workspaceDir?: string
    workspaceId?: string
    secretBrokering?: SandboxSecretBrokering
    sandboxOwner?: string
    provisionedRunner?: RuntimeNativeHarnessId
  } = {},
): Promise<RuntimeConfigSnapshot> {
  const config = await loadUserConfig()
  const selected = snapshotDefaultHarness(config, options.provisionedRunner)
  if (selected?.kind === "connection") {
    const connection = config.connections[selected.connectionId]
    if (!connection || !connection.enabled) {
      throw invalidSchema("selected connection is not installed and enabled")
    }
  }
  const providerDefinitions = listCustomProviders(options.orgId).map((provider) => ({
    id: provider.providerID, name: provider.name, npm: "@ai-sdk/openai-compatible" as const,
    baseURL: provider.baseURL, headers: provider.headers, models: provider.models, credentialProviderId: provider.providerID,
    credentialSource: provider.env.length ? "machine-env" as const : "account" as const,
  }))
  const scope = options.secretScope ?? "local"
  const auth = await agentConfigOptions.projectAuth?.({
    scope,
    ...(options.orgId ? { orgId: options.orgId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.secretBrokering ? { secretBrokering: options.secretBrokering } : {}),
    ...(options.sandboxOwner ? { sandboxOwner: options.sandboxOwner } : {}),
  }) ?? { machineOwnerUserId: "", accounts: {} }
  const plugins = await agentConfigOptions.pluginRuntime?.()
  return {
    version: 4,
    mcp: plugins?.mcp ?? {},
    connections: Object.values(config.connections),
    ...(selected ? { defaultHarness: selected } : {}),
    auth,
    providerDefinitions,
    commands: await listCommands(),
    ...(plugins && Object.keys(plugins.harnessLaunch).length ? { harnessLaunch: plugins.harnessLaunch } : {}),
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

export async function listCommands(): Promise<CommandItem[]> {
  await fs.promises.mkdir(commandDir(), { recursive: true, mode: 0o755 })
  const files = await fs.promises.readdir(commandDir())
  const commands: CommandItem[] = []
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    try {
      commands.push({ name: file.slice(0, -3), content: await fs.promises.readFile(path.join(commandDir(), file), "utf-8") })
    } catch (error) {
      // A delete between the listing and this read removed the command; it is
      // not in the list, and the delete publishes its own snapshot.
      if (isMissingFile(error)) continue
      throw error
    }
  }
  return commands
}

export async function getCommand(name: string): Promise<CommandItem | null> {
  const safe = sanitizeName(name)
  try {
    const content = await fs.promises.readFile(path.join(commandDir(), `${safe}.md`), "utf-8")
    return { name: safe, content }
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

export async function saveCommand(name: string, content: string): Promise<string> {
  await fs.promises.mkdir(commandDir(), { recursive: true, mode: 0o755 })
  const safe = sanitizeName(name)
  await fs.promises.writeFile(path.join(commandDir(), `${safe}.md`), content, { mode: 0o644 })
  log.info("Saved command", { name: safe })
  return safe
}

export async function deleteCommand(name: string): Promise<void> {
  const safe = sanitizeName(name)
  try {
    await fs.promises.unlink(path.join(commandDir(), `${safe}.md`))
    log.info("Deleted command", { name: safe })
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}
