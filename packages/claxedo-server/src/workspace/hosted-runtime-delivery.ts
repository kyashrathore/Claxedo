import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxBrokeredSecret, SandboxEnsureResult, SandboxManager, SandboxManagerInput } from "@claxedo/sandbox-manager"
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
import { projectEnvironment } from "@claxedo/server-core/projects/environment"
import { workspaceRuntimeProjectEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { storeRenewal } from "../credentials/store-renewal"
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "./route-support"
import { mintSupervisorBackplaneToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createWorkspaceRuntimeClient, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { cloudRootBacking } from "./cloud-root-backing"
import { createHostedRuntimeFetch } from "./relay-runtime-client"
import { withTimeout } from "../platform/runtime/timeout"
import { recordRuntimeStartPhases } from "./runtime-start-phases"
import type { ReadySandboxTarget, SandboxStart, SandboxStartAnswer, SandboxStartDrive } from "./sandbox-start"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"

const log = Log.create({ service: "hosted-runtime-delivery" })

/**
 * How long a ready lease's runtime gets to answer before the start treats the
 * sandbox as asleep and resumes it. A serving runtime answers its config
 * status in well under a second from any colo; a Boat sandbox that stopped
 * on its own answers nothing until a resume brings it back.
 */
const LIVE_ANSWER_MS = 3_000

async function supervisorClientFor(workspaceId: string, target: ReadySandboxTarget, signingEnv: Record<string, string | undefined>) {
  const token = await mintSupervisorBackplaneToken({ workspaceId, hostId: target.hostId, subject: "workspace-supervisor" }, signingEnv)
  return { client: createWorkspaceRuntimeClient({ baseUrl: target.url }), options: { token: token.supervisorBackplaneToken } }
}

/** Whether the runtime holds the settings a push delivered; a revision past the first is being replaced, not still awaited. */
const provisioned = (status: Awaited<ReturnType<WorkspaceRuntimeClient["configStatus"]>>) => status.state === "applied" || (status.state === "applying" && status.revision > 1)

async function supervisorClient(
  services: ControlPlaneServices,
  workspaceId: string,
  signingEnv: Record<string, string | undefined>,
) {
  const manager = services.sandbox.sandboxManager
  if (!manager) throw new Error("hosted sandbox manager is unavailable")
  const target = await manager.target(workspaceId)
  if (target.status !== "ready") throw new Error(`hosted sandbox ${workspaceId} is unavailable`)
  return supervisorClientFor(workspaceId, target, signingEnv)
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
  workspaceSecretBrokering: (workspaceId: string) => Promise<SandboxSecretBrokering>
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
  /** The workspace's provisioner's refresh, which re-delivers a running sandbox's settings without racing a start on the same epoch. */
  sandboxRefresh: SandboxStart
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
      secretBrokering: await input.workspaceSecretBrokering(workspaceId),
    })
    return { delivered, selections }
  }
  const runtimeAuth = async (workspaceId: string, person: { userId: string; orgId: string }): Promise<CredentialSnapshot> => {
    const { delivered, selections } = await deliveries(workspaceId, person)
    return nativeProviderAuth(delivered, { owner: person.userId, machineOwnerUserId: person.userId, selections })
  }
  // A machine-placed workspace gets its provider config from its own machine
  // through the host connector; no hosted sandbox serves it.
  const prepare = async ({ workspaceId }: WorkspaceRuntimeContext): Promise<WorkspaceRuntimePreparation> => {
    if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return {}
    const person = await owner(workspaceId)
    return {
      secrets: nativeProviderSecrets((await deliveries(workspaceId, person)).delivered),
      env: workspaceRuntimeProjectEnv(await projectEnvironment(input.credentials(person.orgId), person.orgId).values(person.projectId)),
    }
  }
  const push = async (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined) => {
    if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return
    const person = await owner(workspaceId)
    const config = await userAgentConfigStore(input.settings, person.userId).read()
    const snapshot = composeRuntimeConfigSnapshot({
      config,
      provisionedRunner: input.provisionedRunner,
      providers: [],
      commands: [],
      auth: await runtimeAuth(workspaceId, person),
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
  const refused = (code: "runtime_prepare_failed" | "runtime_provision_failed", cause: unknown, message: string): SandboxStartAnswer =>
    ({ status: "failed", code, message: cause instanceof Error ? cause.message : message })
  // One step of a start: the runtime's preparation, the manager step over the
  // full sandbox input, and a ready runtime's settings. The preparation is
  // rebuilt on every step so a credential that changed mid-start reaches the
  // driver and the runtime alike.
  const step = async (
    workspaceId: string,
    run: (sandboxInput: SandboxManagerInput) => Promise<SandboxEnsureResult>,
  ): Promise<SandboxStartAnswer> => {
    const context = { workspaceId }
    let preparation: WorkspaceRuntimePreparation
    try {
      preparation = await hooks.prepareRuntime(context)
    } catch (cause) {
      return refused("runtime_prepare_failed", cause, "Runtime preparation failed")
    }
    const ensured = await run(await input.sandboxInput(workspaceId, { preparation, secrets: [] }))
    if (ensured.status !== "ready") return ensured
    try {
      await provisionRuntime(context, preparation)
    } catch (cause) {
      return refused("runtime_provision_failed", cause, "Runtime provisioning failed")
    }
    return ensured
  }
  const start: SandboxStartDrive = {
    acquire: async (workspaceId) => {
      let opened = false
      const answer = await step(workspaceId, (sandboxInput) =>
        input.sandboxManager.acquire(workspaceId, { ...sandboxInput, onLeaseOpened: () => { opened = true } }))
      return answer.status === "provisioning" && opened ? { ...answer, opened: true } : answer
    },
    provision: (workspaceId, epoch) => step(workspaceId, (sandboxInput) => input.sandboxManager.provision(workspaceId, epoch, sandboxInput)),
    target: (workspaceId) => input.sandboxManager.target(workspaceId),
    live: async (workspaceId) => {
      const target = await input.sandboxManager.target(workspaceId)
      if (target.status !== "ready") return undefined
      const { client, options } = await supervisorClientFor(workspaceId, target, input.signingEnv)
      const status = await withTimeout(client.configStatus(options), LIVE_ANSWER_MS).catch(() => undefined)
      return status && provisioned(status) ? target : undefined
    },
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
    if ((await input.sandboxManager.target(workspaceId)).status !== "ready") return
    const answer = await input.sandboxRefresh(workspaceId)
    if (answer.status === "failed") throw new Error(answer.message)
    if (answer.status === "unavailable") throw new Error(`hosted runtime refresh failed: ${answer.error}`)
  }
  const refreshRunning = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    await Promise.all((await running(predicate)).map(refresh))
  }
  return {
    prepareRuntime: prepare,
    provisionRuntime,
    start,
    /** The accounts a cloud workspace's sandbox is delivered, as its runtime sees them; nothing for a workspace no sandbox serves. */
    credentialSnapshot: async (workspaceId: string): Promise<CredentialSnapshot | undefined> => {
      if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return undefined
      return runtimeAuth(workspaceId, await owner(workspaceId))
    },
    /** Whether a ready sandbox has taken its settings; a refresh over applied settings keeps it connectable. */
    runtimeProvisioned: async ({ workspaceId }: WorkspaceRuntimeContext) => {
      const { client, options } = await supervisorClient(input.services, workspaceId, input.signingEnv)
      const status = await client.configStatus(options)
      if (status.state === "failed") throw new Error(status.error?.message ?? "Runtime settings application failed")
      return provisioned(status)
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
