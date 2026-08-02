import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "./control-plane/auth"
import type { WorkspaceAuthority } from "./control-plane/authority"
import type { HostTunnelTokenSigner } from "./control-plane/runtime-access-token"
import type { RemoteAccessService } from "./routes/remote-access"
import type { LocalHostIdentity } from "./routes/workspace/local-host"

type LocalWorkspace = {
  id: string
  kind: "local" | "cloud"
  displayName: string
  projectId?: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
}

export function createRemoteAccessService(input: {
  authority: WorkspaceAuthority
  relayUrl: string
  hostTunnelTokenSigner: HostTunnelTokenSigner
  listLocalWorkspaces(): Promise<LocalWorkspace[]>
  subscribeLocalWorkspaces?(listener: () => Promise<void>): () => void
  localHostIdentity(): Promise<LocalHostIdentity>
  signHostPayload(identity: LocalHostIdentity, payload: string): string
  registrationPayload(input: {
    workspaceId: string
    hostId: string
    challengeId: string
    nonce: string
  }): string
  startMachineTunnel(input: {
    workspaceIds: string[]
    hostId: string
    relayUrl: string
    hostTunnelTokenProvider: () => Promise<string>
  }): Promise<{ connectionCount: number; workspaceIds: string[] }>
  stopMachineTunnel(hostId: string): boolean
  machineTunnelActive?(hostId: string): boolean
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void
}): RemoteAccessService {
  let enrollment: {
    auth: SignedControlPlaneAuth
    displayName: string
    startAtLogin: boolean
    identity: LocalHostIdentity
    registered: Set<string>
  } | undefined
  let sync = Promise.resolve<void>(undefined)

  const syncMachine = async () => {
    if (!enrollment) throw new Error("Remote access is not enabled")
    const workspaces = (await input.listLocalWorkspaces()).filter((workspace) => workspace.kind === "local")
    if (!workspaces.length) throw new Error("Open a local project before enabling remote access")
    await Promise.all(workspaces.filter((workspace) => !enrollment!.registered.has(workspace.id)).map(async (workspace) => {
      const challenge = await input.authority.createLocalHostLinkChallenge(enrollment!.auth, {
        workspaceId: workspace.id,
        hostId: enrollment!.identity.hostId,
      })
      await input.authority.registerLocalHostLink(enrollment!.auth, {
        workspaceId: workspace.id,
        hostId: enrollment!.identity.hostId,
        publicKey: enrollment!.identity.publicKey,
        challengeId: challenge.challenge_id,
        signature: input.signHostPayload(enrollment!.identity, input.registrationPayload({
          workspaceId: workspace.id,
          hostId: enrollment!.identity.hostId,
          challengeId: challenge.challenge_id,
          nonce: challenge.nonce,
        })),
        displayName: enrollment!.displayName,
      })
      await input.authority.registerLocalForSharing(enrollment!.auth, {
        workspaceId: workspace.id,
        displayName: workspace.displayName,
        projectId: workspace.projectId,
        repoUrl: workspace.repoUrl,
        repoName: workspace.repoName,
        gitBranch: workspace.gitBranch,
      })
      enrollment!.registered.add(workspace.id)
    }))
    const workspaceIds = workspaces.map((workspace) => workspace.id).sort()
    const tunnel = await input.startMachineTunnel({
      workspaceIds,
      hostId: enrollment.identity.hostId,
      relayUrl: input.relayUrl,
      hostTunnelTokenProvider: async () => (await input.hostTunnelTokenSigner({
        subject: enrollment!.auth.user.subject,
        hostId: enrollment!.identity.hostId,
        workspaceIds,
      })).hostTunnelToken,
    })
    return {
      hostId: enrollment.identity.hostId,
      workspaceIds: tunnel.workspaceIds,
      connectionCount: tunnel.connectionCount,
    }
  }

  input.subscribeLocalWorkspaces?.(() => {
    if (!enrollment) return Promise.resolve()
    const next = sync.then(syncMachine)
    sync = next.then(() => undefined, () => undefined)
    return next.then(() => undefined)
  })

  const devices = async (auth: SignedControlPlaneAuth) => {
    const links = await activeLinks(input.authority, auth)
    return [...links.reduce((groups, link) => {
      const existing = groups.get(link.hostId)
      if (existing) {
        existing.workspaceIds.push(link.workspaceId)
        existing.lastSeenAt = Math.max(existing.lastSeenAt, link.lastSeenAt)
        return groups
      }
      groups.set(link.hostId, {
        hostId: link.hostId,
        displayName: link.displayName,
        lastSeenAt: link.lastSeenAt,
        workspaceIds: [link.workspaceId],
      })
      return groups
    }, new Map<string, {
      hostId: string
      displayName: string
      lastSeenAt: number
      workspaceIds: string[]
    }>()).values()].map((device) => ({ ...device, workspaceIds: device.workspaceIds.sort() }))
  }

  return {
    async status(auth) {
      if (!auth) return { enrolled: false, enabled: false, secondDeviceOpen: false }
      const identity = await input.localHostIdentity()
      const enrolled = (await devices(auth)).some((device) => device.hostId === identity.hostId)
      return {
        enrolled,
        enabled: enrolled && (input.machineTunnelActive?.(identity.hostId) ?? true),
        secondDeviceOpen: (await activeLinks(input.authority, auth)).some((link) => !!link.secondDeviceOpenAt),
      }
    },
    async enable(auth, options) {
      await input.authority.usersMe(auth)
      enrollment = {
        auth,
        displayName: options.displayName,
        startAtLogin: options.startAtLogin,
        identity: await input.localHostIdentity(),
        registered: new Set(),
      }
      const result = await syncMachine()
      input.capture(auth.user.subject, "remote_access_enabled", {
        hostId: result.hostId,
        workspaceCount: result.workspaceIds.length,
        startAtLogin: options.startAtLogin,
      })
      return result
    },
    devices,
    async revoke(auth, hostId) {
      const links = (await activeLinks(input.authority, auth)).filter((link) => link.hostId === hostId)
      await Promise.all(links.map((link) => input.authority.pauseLocalHostLink(auth, {
        workspaceId: link.workspaceId,
        hostId,
        paused: true,
      })))
      if (links.length > 0) input.stopMachineTunnel(hostId)
      return { revoked: links.length > 0 }
    },
    async markSecondDeviceOpen(auth, workspaceId) {
      const result = await input.authority.markSecondDeviceOpen?.(auth, { workspaceId })
      if (!result) throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Second-device completion storage is unavailable")
      if (result.recorded) input.capture(auth.user.subject, "second_device_open", { workspaceId })
      return { recorded: result.recorded }
    },
  }
}

export function unavailableRemoteAccessService(): RemoteAccessService {
  const unavailable = async (): Promise<never> => {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
  }
  return {
    status: async () => ({ enrolled: false, enabled: false, secondDeviceOpen: false }),
    enable: unavailable,
    devices: unavailable,
    revoke: unavailable,
    markSecondDeviceOpen: unavailable,
  }
}

async function activeLinks(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth) {
  return (await Promise.all(workspaceIds(await authority.listWorkspaces(auth)).map(async (workspaceId) => {
    const value = await authority.activeLocalHostLink(auth, { workspaceId })
    if (!value.active) return
    const row = value as typeof value & { display_name?: string }
    return {
      hostId: value.host_id,
      workspaceId,
      displayName: row.display_name ?? value.host_id,
      lastSeenAt: value.last_seen_at,
      secondDeviceOpenAt: value.second_device_open_at,
    }
  }))).filter((value): value is NonNullable<typeof value> => !!value)
}

function workspaceIds(input: unknown) {
  if (!Array.isArray(input)) return []
  return input.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const workspaceId = (value as Record<string, unknown>).workspace_id
    return typeof workspaceId === "string" ? [workspaceId] : []
  })
}
