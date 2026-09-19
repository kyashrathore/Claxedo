import { machineDisplayName } from "@claxedo/helpers/machine-name"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  HostAssignmentAck,
  HostAssignmentDescription,
  HostMachineHeartbeatResult,
  HostSessionAuthority,
  MachinePrincipal,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import type { HostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { RemoteAccessService } from "../../routes/remote-access"
import { hostedRemoteAccessService } from "../hosted-shared/hosted-remote-access-service"
import type { LocalHostAssignments, LocalWorkspaceShare } from "../../workspace/route-support"
import { hostEnrollmentPayload, type LocalHostIdentity } from "../../workspace/local-host"

const log = Log.create({ service: "remote-access" })

type LocalWorkspace = {
  id: string
  kind: "local" | "cloud"
  /** The path on this box; the control plane describes an assignment by it. */
  directory: string
  displayName: string
  projectId?: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
}

/**
 * The heartbeat lease default matches the authorities' DEFAULT_TTL_MS; beating
 * at a third of it keeps the lease alive across one missed beat.
 */
const DEFAULT_HEARTBEAT_TTL_MS = 60_000

/** At most three beats per reconciliation: learn the descriptions, ack them, confirm the set stopped moving. */
const RECONCILE_BEATS = 3

/**
 * This process cannot beat as the machine the enrollment names: the row is
 * gone, or it holds a key this box does not have. `verifyMachineRequest`
 * answers both with one refusal on the wire. The class is the marker rather
 * than the code, because `ControlPlaneAuthError` has none for it and the loop
 * must not read a code every other denial in the product shares.
 */
class MachineIdentityRefused extends ControlPlaneAuthError {
  constructor(message: string) {
    super(403, "workspace_authorization_denied", message)
  }
}

/**
 * Authority refusals that every later beat earns again: the enrollment no
 * longer admits this machine, or a newer instance holds the serving
 * generation. Recovery is always a fresh `enable`, never another beat.
 *
 * `enrollment_paused` is deliberately absent. A pause is set and lifted from
 * the same owner route, so the retry is what brings a headless box back when
 * the owner flips remote access on again; stopping would leave it dark until
 * someone logged in.
 */
const DECISIVE_BEAT_REFUSALS: ReadonlySet<unknown> = new Set([
  "enrollment_revoked",
  "enrollment_owner_ineligible",
  "enrollment_key_version_mismatch",
  "enrollment_generation_superseded",
])

function decisiveBeatRefusal(error: unknown) {
  return error instanceof MachineIdentityRefused || DECISIVE_BEAT_REFUSALS.has(asRecord(error)?.code)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * This node's own machine: the owner-facing service, the local share seam, and
 * the enrollment the serving loop currently holds.
 */
export type LocalRemoteAccessService = RemoteAccessService & LocalHostAssignments & {
  /**
   * The enrollment this process serves under, or nothing while it serves
   * under none. The bootstrap declares it, which is how a client tells a
   * workspace row placed on THIS node from one it must relay to.
   */
  servingEnrollmentId(): string | undefined
}

/**
 * Machine-wide remote access for the box the self-hosted Node control plane
 * runs on.
 *
 * The grain is enrollment + assignments, not per-workspace links:
 *
 *   1. The machine enrolls ONCE (`createHostEnrollmentRequest` → `enrollHost`),
 *      signing the enroll-v1 payload with the persisted P-256 identity from
 *      `workspace/local-host.ts`, then claims a serving generation.
 *   2. Sharing a workspace is the owner's `assignWorkspaceHost` declaration —
 *      pure data, no challenge and no signature of its own. It always names a
 *      directory: the control plane describes only an assignment whose
 *      workspace has one, and a machine acks descriptions.
 *   3. One beat per interval acks, at the revision each description carries,
 *      the descriptions for workspaces this machine consents to serve. That
 *      acked set is what routes and what feeds the machine relay tunnel.
 *
 * Routing requires all three: owner-assigned AND machine-acked at the current
 * revision AND live lease.
 *
 * The beat is `heartbeatHostEnrollmentByMachine`, the method a `claxedo
 * connect` box reaches over the wire after `verifyMachineRequest` builds its
 * principal. Here the principal is read straight from the enrollment row:
 * there is no wire for a machine signature to authenticate across, because
 * this process holds the authority itself, and the authority re-asserts
 * revocation, pause, key version and generation inside every write.
 *
 * The owner's fleet (machines enrolled through invitations, `claxedo connect`)
 * lives in the same authority: revoking one of them is the hosted owner
 * service's revoke; revoking THIS machine is the same revoke plus closing its
 * tunnel and heartbeat loop.
 */
export function createRemoteAccessService(input: {
  authority: WorkspaceAuthority
  relayUrl: string
  hostTunnelTokenSigner: HostTunnelTokenSigner
  listLocalWorkspaces(): Promise<LocalWorkspace[]>
  subscribeLocalWorkspaces?(listener: () => Promise<void>): () => void
  localHostIdentity(): Promise<LocalHostIdentity>
  signHostPayload(identity: LocalHostIdentity, payload: string): string
  /**
   * How the runtime this machine serves composed its session access, asked at
   * every beat rather than captured once: the composition belongs to the
   * runtime, and this service only reports it.
   */
  sessionAuthority(): HostSessionAuthority
  startMachineTunnel(input: {
    workspaceIds: string[]
    hostId: string
    relayUrl: string
    hostTunnelTokenProvider: () => Promise<string>
  }): Promise<{ connectionCount: number; workspaceIds: string[] }>
  stopMachineTunnel(hostId: string): boolean
  machineTunnelActive?(hostId: string): boolean
  heartbeatTtlMs?: number
  heartbeatIntervalMs?: number
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void
}): LocalRemoteAccessService {
  const authority = input.authority
  const owner = hostedRemoteAccessService(authority)
  const heartbeatTtlMs = input.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? Math.floor(heartbeatTtlMs / 3)

  type ServingState = {
    auth: SignedControlPlaneAuth
    displayName?: string
    startAtLogin: boolean
    identity: LocalHostIdentity
    enrollmentId: string
    /** Claimed by this instance; a beat of any earlier generation is refused. */
    generation: number
    /** The workspaces this machine consents to serve. */
    served: Set<string>
    /** The owner's descriptions as the last beat delivered them, by workspace id. */
    descriptions: Map<string, HostAssignmentDescription>
    timer?: ReturnType<typeof setInterval>
  }
  let state: ServingState | undefined
  /** Beats and set mutations are serialized so no two reconciliations interleave. */
  let sync = Promise.resolve<unknown>(undefined)

  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = sync.then(work, work)
    sync = next.then(() => undefined, () => undefined)
    return next
  }

  function requireMethod<T>(method: T | undefined, what: string): NonNullable<T> {
    if (!method) {
      throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", `This control plane does not support ${what}`)
    }
    return method
  }

  async function localWorkspaces() {
    return (await input.listLocalWorkspaces()).filter((workspace) => workspace.kind === "local")
  }

  /**
   * The verified-machine caller, read fresh for every acquire and beat: the
   * key version and the serving generation it carries are what the authority
   * compares its stored row against, so a key replaced or a generation taken
   * by another instance is refused rather than written over.
   *
   * The key comparison is the half `verifyMachineRequest` gets from the
   * signature and this path has no wire to get it from. Without it the key
   * version is read from the same row it is checked against, so an owner who
   * enrolled a different key under this host id would leave this process
   * beating for a machine that is no longer it. Compared as stored text,
   * which is how the adapters decide a re-enroll changed the key.
   */
  async function machinePrincipal(enrollmentId: string, identity: LocalHostIdentity): Promise<MachinePrincipal> {
    const row = await requireMethod(authority.machineAuth, "machine heartbeats").lookupEnrollment(enrollmentId)
    if (!row || row.public_key_json !== identity.publicKey) {
      throw new MachineIdentityRefused("This machine is not the one this enrollment holds")
    }
    return {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      ownerActorId: row.owner_actor_id,
      scope: row.scope,
      keyVersion: row.key_version,
      generation: row.serving_generation,
    }
  }

  async function enrollMachine(auth: SignedControlPlaneAuth, displayName?: string) {
    const identity = await input.localHostIdentity()
    const request = await requireMethod(authority.createHostEnrollmentRequest, "machine enrollment")(auth, {
      hostId: identity.hostId,
    })
    const enrollment = await requireMethod(authority.enrollHost, "machine enrollment")(auth, {
      hostId: identity.hostId,
      publicKey: identity.publicKey,
      requestId: request.request_id,
      signature: input.signHostPayload(identity, hostEnrollmentPayload({
        hostId: identity.hostId,
        requestId: request.request_id,
        nonce: request.nonce,
      })),
      ...(displayName ? { displayName } : {}),
    })
    return { identity, enrollment }
  }

  /**
   * Take over serving for this enrollment. Readiness written by any earlier
   * instance is dropped in the same batch, so what routes after this is only
   * what this instance goes on to ack.
   */
  async function acquireGeneration(enrollmentId: string, identity: LocalHostIdentity) {
    const acquire = requireMethod(authority.acquireHostServingGeneration, "machine heartbeats")
    return (await acquire(await machinePrincipal(enrollmentId, identity))).generation
  }

  /**
   * Become the serving instance for one enrollment: claim its generation and
   * replace any state a previous one left, its beat loop included — two loops
   * over one enrollment would each undo the other's acks.
   */
  async function startServing(serving: {
    auth: SignedControlPlaneAuth
    identity: LocalHostIdentity
    enrollmentId: string
    displayName?: string
    startAtLogin: boolean
    served: Set<string>
  }) {
    stopLoop()
    state = undefined
    const generation = await acquireGeneration(serving.enrollmentId, serving.identity)
    state = {
      auth: serving.auth,
      ...(serving.displayName ? { displayName: serving.displayName } : {}),
      startAtLogin: serving.startAtLogin,
      identity: serving.identity,
      enrollmentId: serving.enrollmentId,
      generation,
      served: serving.served,
      descriptions: new Map(),
    }
    return state
  }

  /** Enroll and claim a generation only when this machine is not already serving this enrollment. */
  async function ensureEnrolled(auth: SignedControlPlaneAuth) {
    const identity = await input.localHostIdentity()
    const active = await requireMethod(authority.activeHostEnrollment, "machine enrollment")(auth)
    const live = active.active && active.host_id === identity.hostId ? active : undefined
    const current = state
    if (current && current.identity.hostId === identity.hostId && live?.enrollment_id === current.enrollmentId) {
      current.auth = auth
      return current
    }
    const enrollmentId = live?.enrollment_id ?? (await enrollMachine(auth, current?.displayName)).enrollment.enrollment_id
    return await startServing({
      auth,
      identity,
      enrollmentId,
      ...(current?.displayName ? { displayName: current.displayName } : {}),
      startAtLogin: current?.startAtLogin ?? false,
      served: current?.served ?? new Set(),
    })
  }

  async function assignOne(auth: SignedControlPlaneAuth, hostId: string, share: LocalWorkspaceShare) {
    const remoteDirectory = share.remoteDirectory
      ?? (await localWorkspaces()).find((workspace) => workspace.id === share.workspaceId)?.directory
    if (!remoteDirectory) {
      throw new Error(`no directory on this machine for workspace ${share.workspaceId}`)
    }
    return await requireMethod(authority.assignWorkspaceHost, "host assignments")(auth, {
      workspaceId: share.workspaceId,
      hostId,
      remoteDirectory,
      ...(share.displayName ? { displayName: share.displayName } : {}),
      ...(share.orgId ? { orgId: share.orgId } : {}),
      ...(share.projectId ? { projectId: share.projectId } : {}),
      ...(share.repoUrl ? { repoUrl: share.repoUrl } : {}),
      ...(share.repoName ? { repoName: share.repoName } : {}),
      ...(share.gitBranch ? { gitBranch: share.gitBranch } : {}),
      ...(share.homeRegion ? { homeRegion: share.homeRegion } : {}),
    })
  }

  /** What this machine consents to serve, at the revision the owner currently describes. */
  function currentAcks(current: ServingState): HostAssignmentAck[] {
    return [...current.descriptions.values()]
      .filter((description) => current.served.has(description.workspace_id))
      .map((description) => ({ workspaceId: description.workspace_id, revision: description.revision }))
      .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0))
  }

  const sameAcks = (before: HostAssignmentAck[], after: HostAssignmentAck[]) =>
    before.length === after.length
    && before.every((ack, index) => after[index]?.workspaceId === ack.workspaceId && after[index]?.revision === ack.revision)

  /**
   * One beat, then reconciliation: consent becomes the owner's assignments
   * this machine can actually serve (assigned ∩ locally present), and the acks
   * follow the descriptions that came back with it. When reconciliation moved
   * the ack set, beat again so it catches up — an assignment made from another
   * surface becomes routable on this beat rather than at the next interval.
   */
  async function beat() {
    if (!state) throw new Error("Remote access is not enabled")
    const current = state
    const heartbeat = requireMethod(authority.heartbeatHostEnrollmentByMachine, "machine heartbeats")
    let result: HostMachineHeartbeatResult | undefined
    for (let attempt = 0; attempt < RECONCILE_BEATS; attempt += 1) {
      const acks = currentAcks(current)
      result = await heartbeat(await machinePrincipal(current.enrollmentId, current.identity), {
        enrollmentId: current.enrollmentId,
        hostId: current.identity.hostId,
        generation: current.generation,
        acks,
        // The machine's own account of the runtime behind every workspace it
        // serves. The control plane mints the client's stream scope from
        // exactly this and refuses to infer one, so a beat that stopped
        // carrying it would leave every client with no workspace stream.
        sessionAuthority: input.sessionAuthority(),
        ttlMs: heartbeatTtlMs,
      })
      current.descriptions = new Map(result.assignments.map((description) => [description.workspace_id, description]))
      const local = new Set((await localWorkspaces()).map((workspace) => workspace.id))
      current.served = new Set(result.assigned_workspace_ids.filter((workspaceId) => local.has(workspaceId)))
      if (sameAcks(acks, currentAcks(current))) break
    }

    const serveable = currentAcks(current).map((ack) => ack.workspaceId)
    const tunnel = serveable.length
      ? await input.startMachineTunnel({
          workspaceIds: serveable,
          hostId: current.identity.hostId,
          relayUrl: input.relayUrl,
          hostTunnelTokenProvider: async () => (await input.hostTunnelTokenSigner({
            subject: current.auth.user.subject,
            hostId: current.identity.hostId,
            workspaceIds: serveable,
          })).hostTunnelToken,
        })
      : (input.stopMachineTunnel(current.identity.hostId), undefined)
    return { result: result!, serveable, tunnel }
  }

  function startLoop() {
    if (!state || state.timer) return
    const timer = setInterval(() => {
      void run(beat).catch((error) => {
        log.warn("machine heartbeat failed", { error: errorMessage(error) })
        const current = state
        if (!current || !decisiveBeatRefusal(error)) return
        // The readiness this instance wrote is already gone or owned by
        // someone else, so the relay tunnel is holding a socket open for
        // workspaces nothing can route to.
        input.stopMachineTunnel(current.identity.hostId)
        stopLoop()
        state = undefined
      })
    }, heartbeatIntervalMs)
    timer.unref?.()
    state.timer = timer
  }

  function stopLoop() {
    if (state?.timer) clearInterval(state.timer)
    if (state) state.timer = undefined
  }

  function workspaceShare(workspace: LocalWorkspace): LocalWorkspaceShare {
    return {
      workspaceId: workspace.id,
      displayName: workspace.displayName,
      remoteDirectory: workspace.directory,
      ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
      ...(workspace.repoUrl ? { repoUrl: workspace.repoUrl } : {}),
      ...(workspace.repoName ? { repoName: workspace.repoName } : {}),
      ...(workspace.gitBranch ? { gitBranch: workspace.gitBranch } : {}),
    }
  }

  /** Assign every locally open project this machine cannot already serve, then beat. */
  async function syncMachine() {
    if (!state) throw new Error("Remote access is not enabled")
    const current = state
    const workspaces = await localWorkspaces()
    if (!workspaces.length) throw new Error("Open a local project before enabling remote access")
    for (const workspace of workspaces) {
      // Consent without a description is not routable: the assignment carries
      // no directory, so re-declaring it with this machine's own path is what
      // makes the workspace describable and therefore ackable.
      if (current.served.has(workspace.id) && current.descriptions.has(workspace.id)) continue
      await assignOne(current.auth, current.identity.hostId, workspaceShare(workspace))
      current.served.add(workspace.id)
    }
    const { tunnel, serveable } = await beat()
    return {
      hostId: current.identity.hostId,
      workspaceIds: serveable,
      connectionCount: tunnel?.connectionCount ?? 0,
    }
  }

  input.subscribeLocalWorkspaces?.(() => {
    if (!state) return Promise.resolve()
    return run(syncMachine).then(() => undefined)
  })

  async function hostTunnelCredential(auth: SignedControlPlaneAuth, hostId: string, workspaceIds: string[]) {
    try {
      const credential = await input.hostTunnelTokenSigner({ subject: auth.user.subject, hostId, workspaceIds })
      return { ...credential, ...(input.relayUrl ? { relayUrl: input.relayUrl } : {}) }
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return undefined
      throw error
    }
  }

  const devices = async (auth: SignedControlPlaneAuth) => {
    const assignments = await requireMethod(authority.listHostAssignments, "host assignments")(auth)
    return assignments.map((assignment) => ({
      hostId: assignment.host_id,
      displayName: assignment.display_name,
      lastSeenAt: assignment.last_seen_at,
      workspaceIds: [...assignment.workspace_ids].sort(),
    }))
  }

  return {
    servingEnrollmentId: () => state?.enrollmentId,
    async status(auth) {
      if (!auth) return { enrolled: false, enabled: false, secondDeviceOpen: false }
      const identity = await input.localHostIdentity()
      const assignments = authority.listHostAssignments ? await authority.listHostAssignments(auth) : []
      let enrolled = assignments.some((assignment) => assignment.host_id === identity.hostId)
      if (!enrolled && authority.activeHostEnrollment) {
        const active = await authority.activeHostEnrollment(auth)
        enrolled = active.active && active.host_id === identity.hostId
      }
      const workspaceIds = [...new Set(assignments.flatMap((assignment) => assignment.workspace_ids))]
      const secondDeviceOpen = (await Promise.all(workspaceIds.map(async (workspaceId) => {
        const host = await authority.activeWorkspaceHost?.(auth, { workspaceId })
        return !!(host?.active && host.second_device_open_at)
      }))).some(Boolean)
      return {
        enrolled,
        enabled: enrolled && (input.machineTunnelActive?.(identity.hostId) ?? true),
        secondDeviceOpen,
      }
    },
    async enable(auth, options) {
      await authority.usersMe(auth)
      const served = state?.served ?? new Set<string>()
      // This process IS the machine, so it names itself here, through the same
      // derivation the desktop uses: one machine, one name, however it
      // publishes itself. A browser asking for remote access can only describe
      // the browser, and a bare `hostname()` keeps the mDNS tail and throws on
      // a host with no name configured.
      const displayName = machineDisplayName(process.platform)
      // Enable always re-enrolls: it re-proves key possession, re-applies the
      // machine's own name, and clears a previous pause deterministically.
      const { identity, enrollment } = await enrollMachine(auth, displayName)
      await startServing({
        auth,
        identity,
        enrollmentId: enrollment.enrollment_id,
        displayName,
        startAtLogin: options.startAtLogin,
        served,
      })
      const result = await run(syncMachine)
      startLoop()
      input.capture(auth.user.subject, "remote_access_enabled", {
        hostId: result.hostId,
        workspaceCount: result.workspaceIds.length,
        startAtLogin: options.startAtLogin,
      })
      return result
    },
    devices,
    rename: owner.rename,
    async revoke(auth, hostId) {
      const result = await owner.revoke(auth, hostId)
      if (!result.revoked) return result
      input.stopMachineTunnel(hostId)
      if (state?.identity.hostId === hostId) {
        stopLoop()
        state = undefined
      }
      return result
    },
    async markSecondDeviceOpen(auth, workspaceId) {
      const result = await input.authority.markSecondDeviceOpen?.(auth, { workspaceId })
      if (!result) throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Second-device completion storage is unavailable")
      if (result.recorded) input.capture(auth.user.subject, "second_device_open", { workspaceId })
      return { recorded: result.recorded }
    },
    async hostId() {
      return (await input.localHostIdentity()).hostId
    },
    async assignWorkspace(auth, share) {
      return await run(async () => {
        const current = await ensureEnrolled(auth)
        const assignment = await assignOne(auth, current.identity.hostId, share)
        current.served.add(share.workspaceId)
        const { serveable } = await beat()
        // Share success = routable: the beat above acked the owner's current
        // description for this workspace, so it is owner-assigned AND
        // machine-acked at that revision AND leased.
        if (!serveable.includes(share.workspaceId)) {
          throw new ControlPlaneAuthError(
            503,
            "workspace_authority_unavailable",
            "The workspace assignment was not acknowledged by the control plane",
          )
        }
        startLoop()
        const hostTunnel = await hostTunnelCredential(auth, current.identity.hostId, [share.workspaceId])
        return { assignment, ...(hostTunnel ? { hostTunnel } : {}) }
      })
    },
    async unassignWorkspace(auth, workspaceId) {
      return await run(async () => {
        const result = await requireMethod(authority.unassignWorkspaceHost, "host assignments")(auth, { workspaceId })
        if (state) {
          state.auth = auth
          state.served.delete(workspaceId)
          state.descriptions.delete(workspaceId)
          // The next beat acks a smaller set, so machine consent shrinks with
          // owner intent and the tunnel set follows.
          await beat()
        }
        return { unassigned: result.unassigned }
      })
    },
  }
}

export function unavailableRemoteAccessService(): LocalRemoteAccessService {
  const unavailable = async (): Promise<never> => {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
  }
  return {
    servingEnrollmentId: () => undefined,
    status: async () => ({ enrolled: false, enabled: false, secondDeviceOpen: false }),
    enable: unavailable,
    devices: unavailable,
    revoke: unavailable,
    rename: unavailable,
    markSecondDeviceOpen: unavailable,
    hostId: unavailable,
    assignWorkspace: unavailable,
    unassignWorkspace: unavailable,
  }
}
