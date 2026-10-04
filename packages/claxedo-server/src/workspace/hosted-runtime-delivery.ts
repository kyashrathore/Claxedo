import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxBrokeredSecret, SandboxDriver, SandboxManager, SandboxManagerInput } from "@claxedo/sandbox-manager"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import { userAgentConfigStore } from "@claxedo/server-core/agent-config/repository"
import { composeRuntimeConfigSnapshot, type AgentPluginRuntimeContribution } from "@claxedo/server-core/agent-config/runtime-snapshot"
import type { RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import {
  nativeProviderAuth,
  nativeProviderDeliveriesFromRepository,
  nativeProviderSecrets,
} from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import { storeRenewal } from "../credentials/store-renewal"
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "./route-support"
import { mintSupervisorBackplaneToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createWorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { cloudRootBacking } from "./cloud-root-backing"
import { createHostedRuntimeFetch } from "./relay-runtime-client"
import { recordRuntimeStartPhases } from "./runtime-start-phases"

const log = Log.create({ service: "hosted-runtime-delivery" })

async function supervisorClient(
  services: ControlPlaneServices,
  workspaceId: string,
  signingEnv: Record<string, string | undefined>,
) {
  const manager = services.sandbox.sandboxManager
  if (!manager) throw new Error("hosted sandbox manager is unavailable")
  const target = await manager.target(workspaceId)
  if (target.status !== "ready") throw new Error(`hosted sandbox ${workspaceId} is unavailable`)
  const token = await mintSupervisorBackplaneToken({ workspaceId, hostId: target.hostId, subject: "workspace-supervisor" }, signingEnv)
  return { client: createWorkspaceRuntimeClient({ baseUrl: target.url }), options: { token: token.supervisorBackplaneToken } }
}

/**
 * The whole stack a sandbox is provisioned with. The base delivery supplies
 * provider credentials and settings. Plugin materialization precedes the
 * snapshot so the native launch rows and ACP servers arrive together.
 */
export type HostedRuntimeHooks = {
  prepareRuntime: (context: WorkspaceRuntimeContext) => Promise<WorkspaceRuntimePreparation>
  pluginRuntime?: (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined) => Promise<AgentPluginRuntimeContribution>
}

export function createHostedRuntimeDelivery(input: {
  authority: WorkspaceAuthority
  /** The control-plane database whose workspace row says whether a hosted sandbox serves the workspace. */
  database: D1Database
  services: ControlPlaneServices
  sandboxManager: SandboxManager
  workspaceDriver: (workspaceId: string) => Promise<SandboxDriver>
  sandboxInput(
    workspaceId: string,
    prepared: { preparation: WorkspaceRuntimePreparation | undefined; secrets: readonly SandboxBrokeredSecret[] },
  ): Promise<SandboxManagerInput>
  settings: UserAgentConfigRepository
  credentials(orgId: string): ControlPlaneCredentials
  signingEnv: Record<string, string | undefined>
  provisionedRunner: RuntimeNativeHarnessId | undefined
  /** Hands a ready runtime its session rows pass after its settings land; a failure costs its rows until the next push. */
  deliverSessionRowsPass?: (workspaceId: string) => Promise<void>
}) {
  const owner = async (workspaceId: string) => {
    const person = await input.authority.resolveWorkspaceOwner?.(workspaceId)
    if (!person) throw new Error(`workspace ${workspaceId} has no active owner`)
    return person
  }
  const deliveries = async (workspaceId: string, person: { userId: string; orgId: string }) => {
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
      renew: storeRenewal(credentials),
      secretBrokering: (await input.workspaceDriver(workspaceId)).metadata.secretBrokering,
    })
    return { delivered, selections }
  }
  // A machine-placed workspace gets its provider config from its own machine
  // through the host connector; no hosted sandbox serves it.
  const prepare = async ({ workspaceId }: WorkspaceRuntimeContext): Promise<WorkspaceRuntimePreparation> => {
    if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return {}
    const person = await owner(workspaceId)
    return { secrets: nativeProviderSecrets((await deliveries(workspaceId, person)).delivered) }
  }
  const push = async (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined) => {
    if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return
    const person = await owner(workspaceId)
    const config = await userAgentConfigStore(input.settings, person.userId).read()
    const { delivered, selections } = await deliveries(workspaceId, person)
    const snapshot = composeRuntimeConfigSnapshot({
      config,
      provisionedRunner: input.provisionedRunner,
      providers: [],
      commands: [],
      auth: nativeProviderAuth(delivered, { owner: person.userId, machineOwnerUserId: person.userId, selections }),
      plugins: hooks.pluginRuntime ? await hooks.pluginRuntime(workspaceId, preparation) : { mcp: {}, harnessLaunch: {} },
    })
    const { client, options } = await supervisorClient(input.services, workspaceId, input.signingEnv)
    await client.applyConfig(snapshot, options)
    await input.deliverSessionRowsPass?.(workspaceId).catch((error: unknown) => {
      log.warn("session rows pass delivery failed", { workspaceId, error: String(error) })
    })
    await recordRuntimeStartPhases({
      sandboxManager: input.sandboxManager,
      workspaceId,
      runtimeFetch: (path, init) => createHostedRuntimeFetch(input.services)(workspaceId, person.orgId, path, init),
    }).catch((error: unknown) => {
      log.warn("runtime start phases were not recorded", { workspaceId, error: String(error) })
    })
  }
  const provisionRuntime = (context: WorkspaceRuntimeContext, preparation?: WorkspaceRuntimePreparation) => push(context.workspaceId, preparation)
  const hooks: HostedRuntimeHooks = { prepareRuntime: prepare }
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
    await provisionRuntime(context, preparation)
  }
  const refreshRunning = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    await Promise.all((await running(predicate)).map(refresh))
  }
  return {
    prepareRuntime: prepare,
    provisionRuntime,
    /** Whether a ready sandbox has taken its settings; a refresh over applied settings keeps it connectable. */
    runtimeProvisioned: async ({ workspaceId }: WorkspaceRuntimeContext) => {
      const { client, options } = await supervisorClient(input.services, workspaceId, input.signingEnv)
      const status = await client.configStatus(options)
      if (status.state === "failed") throw new Error(status.error?.message ?? "Runtime settings application failed")
      return status.state === "applied" || (status.state === "applying" && status.revision > 1)
    },
    /** Installs the composed stack; the base hooks alone run until a feature entry calls this. */
    composeRuntime(next: HostedRuntimeHooks) {
      hooks.prepareRuntime = next.prepareRuntime
      hooks.pluginRuntime = next.pluginRuntime
    },
    settingsChanged: (userId: string) => refreshRunning((person) => person.userId === userId),
    pluginsChanged: (userId: string) => refreshRunning((person) => person.userId === userId),
    reconcileCredentialDelivery: (orgId: string) => refreshRunning((person) => person.orgId === orgId),
  }
}
