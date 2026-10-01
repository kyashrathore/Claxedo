import type { AccountScope } from "@claxedo/account-contract/vocabulary"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import * as fs from "fs"
import * as path from "path"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { SandboxDriverConfig } from "@claxedo/sandbox-contract"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
  type ConnectionConfigHooks,
  type HarnessConnectionDescriptor,
  type HarnessConnectionRef,
} from "./connections"
import type { RuntimeHarnessSelection, RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import { composeRuntimeConfigSnapshot, type AgentPluginRuntimeContribution } from "./runtime-snapshot"
import type { RuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import type { SavedCommand } from "@claxedo/agent-runtime-contract"
export type { AgentPluginRuntimeContribution } from "./runtime-snapshot"
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
import { isMissingFile } from "@claxedo/helpers/fs"

const log = Log.create({ service: "agent-config" })

function claxedoDir() {
  return dataDir()
}

function commandDir() {
  return path.join(claxedoDir(), "commands")
}


export type RuntimeConfigSnapshot = RuntimeSnapshot
export type CommandItem = SavedCommand

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
    scope: AccountScope
    orgId?: string
    workspaceId?: string
    /** How this workspace's sandbox can carry a credential, when it has one. */
    secretBrokering?: SandboxSecretBrokering
    /** The person a shared-scope sandbox serves; only their accounts and the org's reach it. */
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
  scope: AccountScope
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


function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}



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
    secretScope?: AccountScope
    orgId?: string
    workspaceDir?: string
    workspaceId?: string
    secretBrokering?: SandboxSecretBrokering
    sandboxOwner?: string
    provisionedRunner?: RuntimeNativeHarnessId
  } = {},
): Promise<RuntimeConfigSnapshot> {
  const config = await loadUserConfig()
  const scope = options.secretScope ?? "local"
  const auth = await agentConfigOptions.projectAuth?.({
    scope,
    ...(options.orgId ? { orgId: options.orgId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.secretBrokering ? { secretBrokering: options.secretBrokering } : {}),
    ...(options.sandboxOwner ? { sandboxOwner: options.sandboxOwner } : {}),
  }) ?? { machineOwnerUserId: "", accounts: {} }
  const plugins = agentConfigOptions.pluginRuntime
    ? await agentConfigOptions.pluginRuntime()
    : { mcp: {}, harnessLaunch: {} }
  return composeRuntimeConfigSnapshot({
    config,
    provisionedRunner: options.provisionedRunner,
    providers: listCustomProviders(options.orgId),
    commands: await listCommands(),
    auth,
    plugins,
  })
}


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
