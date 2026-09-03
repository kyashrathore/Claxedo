import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { HostSessionAuthority, WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { HostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { RemoteAccessService } from "../../routes/remote-access"
import type { LocalHostAssignments, LocalWorkspaceShare } from "../../workspace/route-support"
import {
  hostEnrollmentHeartbeatPayloadV2,
  hostEnrollmentPayload,
  type LocalHostIdentity,
} from "../../workspace/local-host"

const log = Log.create({ service: "remote-access" })

type LocalWorkspace = {
  id: string
  kind: "local" | "cloud"
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

/**
 * Machine-wide remote access for the self-hosted Node product.
 *
 * The grain is enrollment + assignments, not per-workspace links:
 *
 *   1. The machine enrolls ONCE (`createHostEnrollmentRequest` → `enrollHost`),
 *      signing the enroll-v1 payload with the persisted P-256 identity from
 *      `workspace/local-host.ts`.
 *   2. Sharing a workspace is the owner's `assignWorkspaceHost` declaration —
 *      pure data, no challenge and no signature of its own.
 *   3. One heartbeat per interval signs `hostEnrollmentHeartbeatPayloadV2`
 *      over the CURRENT served set. The beat's `assigned_workspace_ids`
 *      reconciles machine consent with owner intent, and the reconciled
 *      serveable set feeds the machine relay tunnel.
 *
 * Routing requires all three: owner-assigned AND machine-acked AND live lease.
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
}): RemoteAccessService & LocalHostAssignments {
  const authority = input.authority
  const heartbeatTtlMs = input.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? Math.floor(heartbeatTtlMs / 3)

  let state: {
    auth: SignedControlPlaneAuth
    displayName?: string
    startAtLogin: boolean
    identity: LocalHostIdentity
    /** The workspaces this machine currently serves — what the next beat signs. */
    served: Set<string>
    timer?: ReturnType<typeof setInterval>
  } | undefined
  /** Beats and set mutations are serialized so no two signatures interleave. */
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
    return method as NonNullable<T>
  }

  async function localWorkspaces() {
    return (await input.listLocalWorkspaces()).filter((workspace) => workspace.kind === "local")
  }

  async function enrollMachine(auth: SignedControlPlaneAuth, displayName?: string) {
    const identity = await input.localHostIdentity()
    const request = await requireMethod(authority.createHostEnrollmentRequest, "machine enrollment")(auth, {
      hostId: identity.hostId,
    })
    await requireMethod(authority.enrollHost, "machine enrollment")(auth, {
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
    return identity
  }

  /** Enroll only when this machine has no live enrollment for this account. */
  async function ensureEnrolled(auth: SignedControlPlaneAuth) {
    const identity = await input.localHostIdentity()
    if (!state || state.identity.hostId !== identity.hostId) {
      state = { auth, startAtLogin: state?.startAtLogin ?? false, identity, served: state?.served ?? new Set() }
    }
    state.auth = auth
    const active = await requireMethod(authority.activeHostEnrollment, "machine enrollment")(auth)
    if (!(active.active && active.host_id === identity.hostId)) {
      await enrollMachine(auth, state.displayName)
    }
    return state
  }

  async function assignOne(auth: SignedControlPlaneAuth, hostId: string, share: LocalWorkspaceShare) {
    return await requireMethod(authority.assignWorkspaceHost, "host assignments")(auth, {
      workspaceId: share.workspaceId,
      hostId,
      ...(share.displayName ? { displayName: share.displayName } : {}),
      ...(share.orgId ? { orgId: share.orgId } : {}),
      ...(share.projectId ? { projectId: share.projectId } : {}),
      ...(share.repoUrl ? { repoUrl: share.repoUrl } : {}),
      ...(share.repoName ? { repoName: share.repoName } : {}),
      ...(share.gitBranch ? { gitBranch: share.gitBranch } : {}),
      ...(share.remoteDirectory ? { remoteDirectory: share.remoteDirectory } : {}),
      ...(share.homeRegion ? { homeRegion: share.homeRegion } : {}),
    })
  }

  /**
   * One signed beat over the current served set, then reconciliation: the
   * served set becomes the owner's assignments this machine can actually serve
   * (assigned ∩ locally present). When reconciliation changed the set, beat
   * again so the acked set catches up — an assignment made from another
   * surface becomes routable on this beat rather than the next interval.
   */
  async function beat() {
    if (!state) throw new Error("Remote access is not enabled")
    const current = state
    const heartbeat = requireMethod(authority.heartbeatHostEnrollment, "machine enrollment")
    let result: { expires_at: number; last_seen_at: number; assigned_workspace_ids: string[] } | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const workspaceIds = [...current.served].sort()
      result = await heartbeat(current.auth, {
        hostId: current.identity.hostId,
        workspaceIds,
        // The machine's own account of the runtime behind every workspace it
        // serves. The control plane mints the client's stream scope from
        // exactly this and refuses to infer one, so a beat that stopped
        // carrying it would leave every client with no workspace stream.
        sessionAuthority: input.sessionAuthority(),
        ttlMs: heartbeatTtlMs,
        signature: input.signHostPayload(current.identity, hostEnrollmentHeartbeatPayloadV2({
          hostId: current.identity.hostId,
          ttlMs: heartbeatTtlMs,
          workspaceIds,
        })),
      })
      const local = new Set((await localWorkspaces()).map((workspace) => workspace.id))
      const reconciled = new Set(result.assigned_workspace_ids.filter((workspaceId) => local.has(workspaceId)))
      current.served = reconciled
      if (reconciled.size === workspaceIds.length && workspaceIds.every((workspaceId) => reconciled.has(workspaceId))) break
    }

    const serveable = [...current.served].sort()
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
    return { result: result!, tunnel }
  }

  function startLoop() {
    if (!state || state.timer) return
    const timer = setInterval(() => {
      void run(beat).catch((error) => {
        log.warn("machine heartbeat failed", { error: error instanceof Error ? error.message : String(error) })
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
      ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
      ...(workspace.repoUrl ? { repoUrl: workspace.repoUrl } : {}),
      ...(workspace.repoName ? { repoName: workspace.repoName } : {}),
      ...(workspace.gitBranch ? { gitBranch: workspace.gitBranch } : {}),
    }
  }

  /** Assign every locally open project that is not served yet, then beat. */
  async function syncMachine() {
    if (!state) throw new Error("Remote access is not enabled")
    const current = state
    const workspaces = await localWorkspaces()
    if (!workspaces.length) throw new Error("Open a local project before enabling remote access")
    for (const workspace of workspaces) {
      if (current.served.has(workspace.id)) continue
      await assignOne(current.auth, current.identity.hostId, workspaceShare(workspace))
      current.served.add(workspace.id)
    }
    const { tunnel } = await beat()
    return {
      hostId: current.identity.hostId,
      workspaceIds: [...current.served].sort(),
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
      const identity = await input.localHostIdentity()
      state = {
        auth,
        displayName: options.displayName,
        startAtLogin: options.startAtLogin,
        identity,
        served: state?.served ?? new Set(),
      }
      // Enable always re-enrolls: it re-proves key possession, applies the new
      // display name, and clears a previous pause deterministically.
      await enrollMachine(auth, options.displayName)
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
    async revoke(auth, hostId) {
      const assignments = await requireMethod(authority.listHostAssignments, "host assignments")(auth)
      if (!assignments.some((assignment) => assignment.host_id === hostId)) return { revoked: false }
      await requireMethod(authority.pauseHostEnrollment, "machine enrollment")(auth, { hostId, paused: true })
      input.stopMachineTunnel(hostId)
      if (state?.identity.hostId === hostId) {
        stopLoop()
        state = undefined
      }
      return { revoked: true }
    },
    async markSecondDeviceOpen(auth, workspaceId) {
      const result = await input.authority.markSecondDeviceOpen?.(auth, { workspaceId })
      if (!result) throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Second-device completion storage is unavailable")
      if (result.recorded) input.capture(auth.user.subject, "second_device_open", { workspaceId })
      return { recorded: result.recorded }
    },
    async assignWorkspace(auth, share) {
      return await run(async () => {
        const current = await ensureEnrolled(auth)
        const assignment = await assignOne(auth, current.identity.hostId, share)
        current.served.add(share.workspaceId)
        const { result } = await beat()
        // Share success = routable: the beat above signed a served set that
        // contains this workspace, so once the owner assignment rides back in
        // the ack the workspace is owner-assigned AND machine-acked AND leased.
        if (!result.assigned_workspace_ids.includes(share.workspaceId)) {
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
          // The next signed set no longer contains the workspace, so machine
          // consent shrinks with owner intent and the tunnel set follows.
          await beat()
        }
        return { unassigned: result.unassigned }
      })
    },
  }
}

export function unavailableRemoteAccessService(): RemoteAccessService & LocalHostAssignments {
  const unavailable = async (): Promise<never> => {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
  }
  return {
    status: async () => ({ enrolled: false, enabled: false, secondDeviceOpen: false }),
    enable: unavailable,
    devices: unavailable,
    revoke: unavailable,
    markSecondDeviceOpen: unavailable,
    assignWorkspace: unavailable,
    unassignWorkspace: unavailable,
  }
}
