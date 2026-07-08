import {
  startWorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnelEvent,
} from "@claxedo/workspace-runtime/relay"
import { Log } from "./log"
import {
  createWorkspaceSupervisorSandboxManager,
  holdSupervisorSandbox,
  releaseSupervisorSandbox,
  workspaceSupervisorServerUrl,
} from "./workspace-supervisor"
import { getWorkspace } from "./workspace-store"

const log = Log.create({ service: "user-hosted-tunnel" })
const sandboxManager = createWorkspaceSupervisorSandboxManager()

type ActiveTunnel = {
  tunnel: WorkspaceRelayHostTunnel
  workspaceId: string
  hostId: string
  relayUrl: string
  token: { current: string }
  url: string
  release: () => void
}

const tunnels = new Map<string, ActiveTunnel>()

function normalized(input: string) {
  return input.trim().replace(/\/+$/, "")
}

function key(input: { workspaceId: string; hostId: string }) {
  return `${input.workspaceId}\n${input.hostId}`
}

function logTunnelEvent(input: { workspaceId: string; hostId: string; relayUrl: string }, event: WorkspaceRelayHostTunnelEvent) {
  const context = {
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    relayUrl: input.relayUrl,
  }
  if (event.type === "auth-failed") {
    log.error("user-hosted workspace tunnel auth failed", { ...context, attempt: event.attempt, error: event.error })
    return
  }
  if (event.type === "reconnecting") {
    log.warn("user-hosted workspace tunnel reconnecting", { ...context, attempt: event.attempt, delayMs: event.delayMs, reason: event.reason })
    return
  }
  if (event.type === "closed") {
    log.info("user-hosted workspace tunnel closed", { ...context, reason: event.reason })
  }
}

async function tunnelTarget(input: { workspaceId: string; hostId: string }) {
  const workspace = await getWorkspace(input.workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${input.workspaceId}`)
  if (workspace.kind !== "cloud") {
    return {
      url: `${workspaceSupervisorServerUrl()}/workspaces/${encodeURIComponent(workspace.id)}`,
      release: () => {},
    }
  }
  const target = await sandboxManager.ensure(workspace.id, {
    homeRegion: "us-east",
    hostId: input.hostId,
  })
  if (target.status !== "ready") throw new Error(`sandbox unavailable: ${workspace.id}`)
  holdSupervisorSandbox(workspace.id)
  return {
    // `localBaseUrl` is the Node-side bridge ingress used by the Relay host
    // tunnel. Product traffic still enters through Relay; this direct URL is
    // not exposed as a client/control-plane target.
    url: target.url,
    release: () => releaseSupervisorSandbox(workspace.id),
  }
}

export async function startUserHostedWorkspaceTunnel(input: {
  workspaceId: string
  hostId: string
  relayUrl: string
  hostTunnelToken: string
}) {
  const relayUrl = normalized(input.relayUrl)
  const existing = tunnels.get(key(input))
  if (existing && existing.relayUrl === relayUrl) {
    existing.token.current = input.hostTunnelToken
    return {
      url: existing.url,
      reused: true,
    }
  }

  existing?.tunnel.close()
  existing?.release()
  const target = await tunnelTarget(input)
  const token = { current: input.hostTunnelToken }
  const tunnel = (() => {
    try {
      return startWorkspaceRelayHostTunnel({
        relayUrl,
        hostId: input.hostId,
        workspaceIds: [input.workspaceId],
        localBaseUrl: target.url,
        tokenProvider: async () => token.current,
        onEvent: (event) => logTunnelEvent({ workspaceId: input.workspaceId, hostId: input.hostId, relayUrl }, event),
        pingIntervalMs: 15_000,
        reconnectIntervalMs: 1_000,
      })
    } catch (err) {
      target.release()
      throw err
    }
  })()
  tunnels.set(key(input), {
    tunnel,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    relayUrl,
    token,
    url: target.url,
    release: target.release,
  })
  log.info("user-hosted workspace tunnel started", {
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    relayUrl,
  })
  return {
    url: target.url,
    reused: false,
  }
}

export function stopUserHostedWorkspaceTunnel(input: {
  workspaceId: string
  hostId: string
}) {
  const existing = tunnels.get(key(input))
  if (!existing) return false
  existing.tunnel.close()
  existing.release()
  tunnels.delete(key(input))
  return true
}

export function stopAllUserHostedWorkspaceTunnels() {
  const count = tunnels.size
  for (const existing of tunnels.values()) {
    existing.tunnel.close()
    existing.release()
  }
  tunnels.clear()
  return count
}
