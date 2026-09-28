import type { SandboxBrokeredSecret, SandboxDriver, SandboxManager, SandboxManagerInput } from "@claxedo/sandbox-manager"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import { userAgentConfigStore } from "@claxedo/server-core/agent-config/repository"
import { snapshotDefaultHarness } from "@claxedo/server-core/agent-config/connections"
import type { RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import type { AcpRuntimeMcpServer } from "@claxedo/server-core/agent-plugins/runtime/mcp-projection"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import {
  nativeProviderAuth,
  nativeProviderDeliveriesFromRepository,
  nativeProviderSecrets,
} from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "./route-support"
import { hostedRuntimeConfigApply } from "./hosted-runtime-fetch"

/**
 * The whole stack a sandbox is provisioned with. The base delivery supplies
 * provider credentials and the settings snapshot; a feature entry (Agent
 * Plugins) layers its own preparation, provisioning and the MCP servers the
 * snapshot carries for custom ACP connections, then registers the composed
 * hooks here so a refresh of a running sandbox runs everything the first
 * connection ran.
 */
export type HostedRuntimeHooks = {
  prepareRuntime: (context: WorkspaceRuntimeContext) => Promise<WorkspaceRuntimePreparation>
  provisionRuntime: (context: WorkspaceRuntimeContext, preparation?: WorkspaceRuntimePreparation) => Promise<void>
  acpMcp?: (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined) => Promise<Record<string, AcpRuntimeMcpServer>>
}

export function createHostedRuntimeDelivery(input: {
  authority: WorkspaceAuthority
  services: ControlPlaneServices
  sandboxManager: SandboxManager
  driver: SandboxDriver
  sandboxInput(
    workspaceId: string,
    prepared: { preparation: WorkspaceRuntimePreparation | undefined; secrets: readonly SandboxBrokeredSecret[] },
  ): Promise<SandboxManagerInput>
  settings: UserAgentConfigRepository
  credentials(orgId: string): ControlPlaneCredentials
  signingEnv: Record<string, string | undefined>
  provisionedRunner: RuntimeNativeHarnessId | undefined
}) {
  const owner = async (workspaceId: string) => {
    const person = await input.authority.resolveWorkspaceOwner?.(workspaceId)
    if (!person) throw new Error(`workspace ${workspaceId} has no active owner`)
    return person
  }
  const deliveries = async (person: { userId: string; orgId: string }) => {
    const credentials = input.credentials(person.orgId)
    const selected = (await credentials.listCredentials())
      .filter((credential) => (credential.kind === "api_key" || credential.kind === "oauth_token")
        && !!builtInProviderRow(credential.provider_id))
      .map((credential) => ({ credential, ...(credential.status !== "available" ? { unavailable: credential.status } : {}) }))
    const selections = await credentials.accountSelections()
    const delivered = await nativeProviderDeliveriesFromRepository({
      owner: person.userId,
      machineOwnerUserId: person.userId,
      selections,
      selected,
      readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
      secretBrokering: input.driver.metadata.secretBrokering,
    })
    return { delivered, selections }
  }
  const prepare = async ({ workspaceId }: WorkspaceRuntimeContext): Promise<WorkspaceRuntimePreparation> => {
    const person = await owner(workspaceId)
    return { secrets: nativeProviderSecrets((await deliveries(person)).delivered) }
  }
  const push = async (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined) => {
    const person = await owner(workspaceId)
    const config = await userAgentConfigStore(input.settings, person.userId).read()
    const { delivered, selections } = await deliveries(person)
    const auth = nativeProviderAuth(delivered, { owner: person.userId, machineOwnerUserId: person.userId, selections })
    const defaultHarness = snapshotDefaultHarness(config, input.provisionedRunner)
    await hostedRuntimeConfigApply(input.services, workspaceId, {
      version: 4 as const,
      commands: [],
      mcp: await hooks.acpMcp?.(workspaceId, preparation) ?? {},
      connections: Object.values(config.connections),
      ...(defaultHarness ? { defaultHarness } : {}),
      auth,
    }, input.signingEnv)
  }
  const hooks: HostedRuntimeHooks = {
    prepareRuntime: prepare,
    provisionRuntime: (context, preparation) => push(context.workspaceId, preparation),
  }
  const running = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    const leases = await input.sandboxManager.list()
    const workspaces = await Promise.all(leases.filter((lease) => lease.status === "ready").map(async (lease) => {
      const person = await input.authority.resolveWorkspaceOwner?.(lease.workspaceId)
      return person && predicate(person) ? lease.workspaceId : undefined
    }))
    return workspaces.filter((workspaceId): workspaceId is string => !!workspaceId)
  }
  const refresh = async (workspaceId: string) => {
    const context = { workspaceId }
    const preparation = await hooks.prepareRuntime(context)
    const target = await input.sandboxManager.target(workspaceId)
    if (target.status !== "ready") return
    const ensured = await input.sandboxManager.ensure(workspaceId, await input.sandboxInput(workspaceId, { preparation, secrets: [] }))
    if (ensured.status !== "ready") throw new Error(`hosted runtime refresh failed: ${ensured.status}`)
    await hooks.provisionRuntime(context, preparation)
  }
  const refreshRunning = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    await Promise.all((await running(predicate)).map(refresh))
  }
  return {
    prepareRuntime: prepare,
    provisionRuntime: hooks.provisionRuntime,
    /** Installs the composed stack; the base hooks alone run until a feature entry calls this. */
    composeRuntime(next: HostedRuntimeHooks) {
      hooks.prepareRuntime = next.prepareRuntime
      hooks.provisionRuntime = next.provisionRuntime
      hooks.acpMcp = next.acpMcp
    },
    settingsChanged: (userId: string) => refreshRunning((person) => person.userId === userId),
    pluginsChanged: (userId: string) => refreshRunning((person) => person.userId === userId),
    reconcileCredentialDelivery: (orgId: string) => refreshRunning((person) => person.orgId === orgId),
  }
}
