import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxBrokeredSecret, SandboxEnsureResult, SandboxManager, SandboxManagerInput } from "@claxedo/sandbox-manager"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import { userAgentConfigStore } from "@claxedo/server-core/agent-config/repository"
import { composeRuntimeConfigSnapshot, type AgentPluginRuntimeContribution } from "@claxedo/server-core/agent-config/runtime-snapshot"
import type { RuntimeNativeHarnessId } from "@claxedo/workspace-runtime/config"
import {
  deliverableRows,
  deliveredAccountsIdentity,
  nativeProviderAuth,
  nativeProviderDeliveriesFromRepository,
  nativeProviderSecrets,
} from "@claxedo/server-core/credentials/native-delivery-plan"
import { projectEnvironment } from "@claxedo/server-core/projects/environment"
import { RUNTIME_LEASE_ENV_PATH, workspaceRuntimeProjectEnv } from "@claxedo/server-core/hosts/workspace-runtime/env"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { storeRenewal } from "../credentials/store-renewal"
import type { CredentialChange } from "../credentials/worker/org-routed"
import type { WorkspaceRuntimeContext, WorkspaceRuntimePreparation } from "./route-support"
import { mintSupervisorBackplaneToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { createWorkspaceRuntimeClient, type WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { cloudRootBacking } from "./cloud-root-backing"
import { createHostedRuntimeFetch } from "./relay-runtime-client"
import { withTimeout } from "../platform/runtime/timeout"
import { recordRuntimeStartPhases } from "./runtime-start-phases"
import type { ReadySandboxTarget, SandboxFollowUps, SandboxStart, SandboxStartAnswer, SandboxStartDrive } from "./sandbox-start"
import type { MachineNotice } from "./machine-notice"
import type { AgentPluginExecutionSelection } from "@claxedo/server-core/agent-plugins/runtime/execution-selection"
import { accountsRenewalDueAt, type CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import { PLACEHOLDER_TTL_SECONDS, type BrokerLease, type HostedEgressBroker } from "../credentials/hosted-egress-broker"
import { isSandboxDriverID } from "@claxedo/sandbox-contract"
import { sandboxDriverCatalog } from "@claxedo/sandbox-manager/driver-catalog"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import { IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_MS, workspaceIdleStopDue } from "../sandbox/workspace-idle"
import type { WorkspaceIdleStop } from "./routes/checkpoints"

const log = Log.create({ service: "hosted-runtime-delivery" })

const runtimeContext = (workspaceId: string, capabilities: AgentPluginExecutionSelection | undefined): WorkspaceRuntimeContext =>
  capabilities ? { workspaceId, capabilities } : { workspaceId }

const soonestDue = (...times: (number | undefined)[]) => {
  const due = times.filter((time): time is number => time !== undefined)
  return due.length ? Math.min(...due) : undefined
}

const RUNTIME_HEALTH_PATH = "/api/wr/health"

/** Whether the sandbox's own host reads its idleness; a driver outside the catalog has a host that reads none. */
const hostWatchesIdle = (target: { driver?: { id: string } }) =>
  isSandboxDriverID(target.driver?.id) && sandboxDriverCatalog[target.driver.id].metadata.hostWatchesIdle === true

/**
 * How long a ready lease's runtime gets to answer before the start treats the
 * sandbox as asleep and resumes it. A serving runtime answers its config
 * status in well under a second from any colo; a Boat sandbox that stopped
 * on its own answers nothing until a resume brings it back.
 */
const LIVE_ANSWER_MS = 3_000

async function supervisorClientFor(workspaceId: string, target: ReadySandboxTarget, signingEnv: Record<string, string | undefined>) {
  const token = await mintSupervisorBackplaneToken({ workspaceId, hostId: target.hostId, subject: "workspace-supervisor" }, signingEnv)
  return { client: createWorkspaceRuntimeClient({ baseUrl: target.url }), options: { token: token.supervisorBackplaneToken }, target }
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
  /** The plane's own egress broker, which serves a workspace whose driver has no provider edge; absent, such a workspace's accounts are refused to its harnesses. */
  broker?: HostedEgressBroker
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
  /** The workspace's provisioner's settings push to a serving sandbox, with no driver step; a run in flight delivers them instead. */
  sandboxRedeliver: (workspaceId: string) => Promise<void>
  /** Stops a lease generation the idle watch found idle, or unreachable for the whole failure budget. */
  idleStop: WorkspaceIdleStop
  /** Ends the turns the workspace's runtime was running when the idle watch found that runtime gone at `at`. */
  runtimeLost?: (workspaceId: string, at: number) => Promise<void>
  /** Tells the workspace owner's open clients that a start began or settled. */
  announce?: MachineNotice
  /** A request to a ready sandbox's runtime over the relay; a test hands in its own runtime. */
  runtimeFetch?: (workspaceId: string, orgId: string, path: string, init: RequestInit) => Promise<Response>
}) {
  const runtimeFetch = input.runtimeFetch ?? createHostedRuntimeFetch(input.services)
  const owner = async (workspaceId: string) => {
    const person = await input.authority.resolveWorkspaceOwner?.(workspaceId)
    if (!person) throw new Error(`workspace ${workspaceId} has no active owner`)
    return person
  }
  /**
   * The owner's accounts as this workspace's sandbox is delivered them. A
   * driver with its own edge gets edge secrets; one without gets bindings on
   * the plane's broker, minted for `lease` when the sandbox is ready and as
   * draft projections otherwise, which decide a draft's refusal and are never
   * applied to a runtime.
   */
  const deliveries = async (workspaceId: string, person: { userId: string; orgId: string }, lease?: BrokerLease) => {
    const credentials = input.credentials(person.orgId)
    const selected = deliverableRows(await credentials.listCredentials())
    const selections = await credentials.accountSelections()
    const secretBrokering = await input.workspaceSecretBrokering(workspaceId)
    const broker = secretBrokering !== "native" && input.broker
      ? input.broker.binder({ orgId: person.orgId, workspaceId, ...(lease ? { lease } : {}) })
      : undefined
    const delivered = await nativeProviderDeliveriesFromRepository({
      owner: person.userId,
      machineOwnerUserId: person.userId,
      selections,
      selected,
      readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
      renew: storeRenewal(credentials),
      secretBrokering,
      ...(broker ? { broker } : {}),
    })
    return { delivered, selections }
  }
  const runtimeAuth = async (workspaceId: string, person: { userId: string; orgId: string }, lease?: BrokerLease): Promise<CredentialSnapshot> => {
    const { delivered, selections } = await deliveries(workspaceId, person, lease)
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
  /**
   * Delivers a ready sandbox its settings; answers when the placeholders it
   * delivered are due again, if any expire, and when its idleness is first
   * read, if its host reads none itself.
   */
  const push = async (workspaceId: string, preparation: WorkspaceRuntimePreparation | undefined): Promise<SandboxFollowUps> => {
    if (await cloudRootBacking(input.database, workspaceId) !== "cloud") return {}
    const person = await owner(workspaceId)
    const appliedAt = Date.now()
    const supervisor = supervisorClient(input.services, workspaceId, input.signingEnv)
    const lease = supervisor.then(({ target }): BrokerLease => ({ epoch: target.epoch, hostId: target.hostId }))
    const [config, { client, options }, auth, plugins, leaseEnv] = await Promise.all([
      userAgentConfigStore(input.settings, person.userId).read(),
      supervisor,
      lease.then((current) => runtimeAuth(workspaceId, person, current)),
      hooks.pluginRuntime ? hooks.pluginRuntime(workspaceId, preparation) : { mcp: {}, harnessLaunch: {} },
      preparation?.leaseEnv
        ? lease.then(preparation.leaseEnv).catch((error: unknown) => {
            log.warn("lease env was not minted; the runtime keeps what it holds until the next renewal", { workspaceId, error: String(error) })
            return undefined
          })
        : undefined,
    ])
    const snapshot = composeRuntimeConfigSnapshot({ config, provisionedRunner: input.provisionedRunner, providers: [], commands: [], auth, plugins })
    await client.applyConfig(snapshot, options)
    const runtime = (path: string, init: RequestInit) => runtimeFetch(workspaceId, person.orgId, path, init)
    // The brokered rows and the lease env alone: a direct plan token is
    // renewed by the harness mid-turn through the credential refresh route,
    // and an edge placeholder never expires.
    const renewAt = soonestDue(
      accountsRenewalDueAt(snapshot.auth, appliedAt),
      preparation?.leaseEnv ? appliedAt + (PLACEHOLDER_TTL_SECONDS * 1_000) / 2 : undefined,
    )
    await Promise.all([
      leaseEnv && runtime(RUNTIME_LEASE_ENV_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(leaseEnv),
      }).then((response) => {
        if (!response.ok) throw new Error(`the runtime answered ${response.status} for its lease env`)
      }).catch((error: unknown) => {
        log.warn("lease env delivery failed; the runtime keeps what it holds until the next renewal", { workspaceId, error: String(error) })
      }),
      input.deliverSessionRowsPass?.(workspaceId).catch((error: unknown) => {
        log.warn("session rows pass delivery failed", { workspaceId, error: String(error) })
      }),
      recordRuntimeStartPhases({
        sandboxManager: input.sandboxManager,
        workspaceId,
        runtimeFetch: runtime,
      }).catch((error: unknown) => {
        log.warn("runtime start phases were not recorded", { workspaceId, error: String(error) })
      }),
    ])
    return { ...(renewAt === undefined ? {} : { renewAt }), watchAt: Date.now() + IDLE_CHECK_MS }
  }
  const hooks: HostedRuntimeHooks = { prepareRuntime: prepare }
  const refused = (code: "runtime_prepare_failed" | "runtime_provision_failed", cause: unknown, message: string): SandboxStartAnswer =>
    ({ status: "failed", code, message: cause instanceof Error ? cause.message : message })
  // One step of a start: the runtime's preparation, the manager step over the
  // full sandbox input, and a ready runtime's settings. The preparation is
  // rebuilt on every step so a credential that changed mid-start reaches the
  // driver and the runtime alike.
  const step = async (
    context: WorkspaceRuntimeContext,
    run: (sandboxInput: SandboxManagerInput) => Promise<SandboxEnsureResult>,
  ): Promise<SandboxStartAnswer> => {
    const workspaceId = context.workspaceId
    let preparation: WorkspaceRuntimePreparation
    try {
      preparation = await hooks.prepareRuntime(context)
    } catch (cause) {
      return refused("runtime_prepare_failed", cause, "Runtime preparation failed")
    }
    const ensured = await run(await input.sandboxInput(workspaceId, { preparation, secrets: [] }))
    if (ensured.status !== "ready") return ensured
    try {
      return { ...ensured, ...await push(workspaceId, preparation) }
    } catch (cause) {
      return refused("runtime_provision_failed", cause, "Runtime provisioning failed")
    }
  }
  const runtimeLost = async (workspaceId: string) => {
    try {
      await input.runtimeLost?.(workspaceId, Date.now())
    } catch (error) {
      log.warn("the turns of a lost runtime's sessions were not ended", { workspaceId, error: String(error) })
    }
  }
  /**
   * One read of a serving runtime over the relay, waited on for as long as
   * the check period: on staging the relay's hop alone took up to 2.9 s and
   * an OpenCode engine boot held the runtime's loop for up to 7.9 s, so a
   * runtime that answers before its next read is due has answered. An answer
   * is the host's proof of life, recorded on the lease, and is read for
   * idleness unless the host reads its own. For a runtime that does not
   * answer the provider is asked: a host it stopped or no longer has ends the
   * lease at once, so the workspace stops reading as running, and a host it
   * says runs only dates the lease's heartbeat, since it bills whether or not
   * its runtime answers. Every read the runtime leaves unanswered is the
   * lease's last health failure and counts against the failure budget,
   * whatever the provider says, logged with the count so far, and a runtime
   * silent for the whole budget is stopped: its host is metered while nobody
   * reaches what it serves. Either way the turns its sessions were running
   * end with it.
   */
  const watch = async (workspaceId: string, failures: number): Promise<number | undefined> => {
    const target = await input.sandboxManager.target(workspaceId)
    if (target.status !== "ready") return undefined
    const person = await owner(workspaceId)
    let report: Record<string, unknown> | undefined
    try {
      const response = await withTimeout(runtimeFetch(workspaceId, person.orgId, RUNTIME_HEALTH_PATH, { method: "GET" }), IDLE_CHECK_MS)
      if (!response.ok) throw new Error(`the runtime answered ${response.status} for its idleness`)
      report = asRecord(await response.json())
      if (report?.workspaceId !== workspaceId) throw new Error("the runtime answered for another workspace")
    } catch (error) {
      const down = await input.sandboxManager.endIfHostDown(workspaceId, target.epoch).catch((inspectError: unknown) => {
        log.warn("the provider did not say whether an unanswering runtime's host runs", { workspaceId, epoch: target.epoch, error: String(inspectError) })
        return undefined
      })
      if (down) {
        log.warn(`sandbox lease ended: its runtime answered no idle check and the provider ${down === "gone" ? "no longer has" : "stopped"} its host`, { workspaceId, epoch: target.epoch, error: String(error) })
        await runtimeLost(workspaceId)
        return undefined
      }
      if (failures + 1 < IDLE_CHECK_FAILURE_LIMIT) {
        log.warn("the runtime answered no idle check; counted toward the failure budget", { workspaceId, epoch: target.epoch, failures: failures + 1, budget: IDLE_CHECK_FAILURE_LIMIT, error: String(error) })
        throw error
      }
      log.warn("sandbox stopped: its runtime answered no idle check for the whole failure budget", { workspaceId, epoch: target.epoch, error: String(error) })
      await input.idleStop(workspaceId, target.epoch, { unresponsiveForMs: IDLE_CHECK_MS * IDLE_CHECK_FAILURE_LIMIT })
      await runtimeLost(workspaceId)
      return undefined
    }
    await input.sandboxManager.heartbeat(workspaceId, { epoch: target.epoch, ok: true })
    const idleBefore = hostWatchesIdle(target) ? undefined : workspaceIdleStopDue(report ?? {}, Date.now())
    if (idleBefore === undefined) return Date.now() + IDLE_CHECK_MS
    const stopped = await input.idleStop(workspaceId, target.epoch, { idleBefore })
    return stopped.ok ? undefined : Date.now() + IDLE_CHECK_MS
  }
  // A runtime that answers is the one proof the plane has that its host
  // serves; the lease records the moment, which is where a host later found
  // gone stops being billed.
  const live = async (workspaceId: string) => {
    const target = await input.sandboxManager.target(workspaceId)
    if (target.status !== "ready") return undefined
    const { client, options } = await supervisorClientFor(workspaceId, target, input.signingEnv)
    const status = await withTimeout(client.configStatus(options), LIVE_ANSWER_MS).catch(() => undefined)
    if (!status || !provisioned(status)) return undefined
    await input.sandboxManager.heartbeat(workspaceId, { epoch: target.epoch, ok: true })
    return target
  }
  const start: SandboxStartDrive = {
    acquire: async (workspaceId, capabilities) => {
      let opened = false
      const answer = await step(runtimeContext(workspaceId, capabilities), (sandboxInput) =>
        input.sandboxManager.acquire(workspaceId, { ...sandboxInput, onLeaseOpened: () => { opened = true } }))
      return answer.status === "provisioning" && opened ? { ...answer, opened: true } : answer
    },
    provision: (workspaceId, epoch, capabilities) =>
      step(runtimeContext(workspaceId, capabilities), (sandboxInput) => input.sandboxManager.provision(workspaceId, epoch, sandboxInput)),
    target: (workspaceId) => input.sandboxManager.target(workspaceId),
    live,
    // A renewal re-delivers the settings of a sandbox that is serving, with
    // placeholders minted afresh; one that stopped is left to the start that
    // resumes it, which delivers again.
    renew: async (workspaceId, capabilities) => {
      if (!await live(workspaceId)) return undefined
      return (await push(workspaceId, await hooks.prepareRuntime(runtimeContext(workspaceId, capabilities)))).renewAt
    },
    watch,
    flushTelemetry: async () => {
      await input.services.telemetry.flush?.()
    },
    ...(input.announce ? { announce: input.announce } : {}),
  }
  const running = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    const leases = await input.sandboxManager.list()
    const workspaces = await Promise.all(leases.filter((lease) => lease.status === "ready").map(async (lease) => {
      const person = await input.authority.resolveWorkspaceOwner?.(lease.workspaceId)
      return person && predicate(person) ? [{ workspaceId: lease.workspaceId, person }] : []
    }))
    return workspaces.flat()
  }
  // A refresh runs the driver, which boots a runtime that is not serving, and
  // whether such a runtime comes back is the liveness watch's decision.
  const refresh = async (workspaceId: string) => {
    if (!await live(workspaceId)) return
    const answer = await input.sandboxRefresh(workspaceId)
    if (answer.status === "failed") throw new Error(answer.message)
    if (answer.status === "unavailable") throw new Error(`hosted runtime refresh failed: ${answer.error}`)
  }
  const refreshRunning = async (predicate: (person: Awaited<ReturnType<typeof owner>>) => boolean) => {
    await Promise.all((await running(predicate)).map(({ workspaceId }) => refresh(workspaceId)))
  }
  /** The identity of the accounts each of the organization's running workspaces is delivered, keyed by workspace. */
  const deliveredIdentities = async (orgId: string) => {
    const credentials = input.credentials(orgId)
    const [rows, selections, workspaces] = await Promise.all([
      credentials.listCredentials(),
      credentials.accountSelections(),
      running((person) => person.orgId === orgId),
    ])
    const selected = deliverableRows(rows)
    return new Map(await Promise.all(workspaces.map(async ({ workspaceId, person }) => [
      workspaceId,
      await deliveredAccountsIdentity({ owner: person.userId, machineOwnerUserId: person.userId, selections, selected }),
    ] as const)))
  }
  /**
   * A workspace whose driver installs accounts on its provider edge takes them
   * through the driver again; one served through the plane's broker or direct
   * takes them in a settings push alone, which its runtime holds until a turn
   * in flight ends.
   */
  const redeliverAccounts = async (workspaceId: string) => {
    if (await input.workspaceSecretBrokering(workspaceId) === "native") return refresh(workspaceId)
    await input.sandboxRedeliver(workspaceId)
  }
  const credentialChange: CredentialChange = async (orgId) => {
    const before = await deliveredIdentities(orgId)
    return async () => {
      const after = await deliveredIdentities(orgId)
      await Promise.all([...after].flatMap(([workspaceId, identity]) =>
        before.get(workspaceId) === identity ? [] : [redeliverAccounts(workspaceId)]))
    }
  }
  return {
    prepareRuntime: prepare,
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
    credentialChange,
  }
}
