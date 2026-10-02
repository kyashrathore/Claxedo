import {
  hostTunnelPreOpenQueueFromEnv,
  startWorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnel,
  type WorkspaceRelayHostTunnelEvent,
} from "@claxedo/workspace-runtime/relay"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { defaultHomeRegion } from "@claxedo/server-core/platform/runtime/region/index"
import {
  createWorkspaceSupervisorSandboxManager,
  holdSupervisorSandbox,
  releaseSupervisorSandbox,
  workspaceSupervisorServerUrl,
} from "./workspace/supervisor"
import { getWorkspace } from "@claxedo/server-core/workspace/store/index"
import { loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"
import { RouteHandler, routeOwnership } from "@claxedo/server-core/platform/governance/route-ownership"

const log = Log.create({ service: "host-tunnel" })
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
    log.error("workspace host tunnel auth failed", { ...context, attempt: event.attempt, error: event.error })
    return
  }
  if (event.type === "reconnecting") {
    log.warn("workspace host tunnel reconnecting", { ...context, attempt: event.attempt, delayMs: event.delayMs, reason: event.reason })
    return
  }
  if (event.type === "closed") {
    log.info("workspace host tunnel closed", { ...context, reason: event.reason })
  }
}

async function tunnelTarget(input: { workspaceId: string; hostId: string }) {
  const workspace = await getWorkspace(input.workspaceId)
  if (!workspace) throw new Error(`workspace not found: ${input.workspaceId}`)
  if (workspace.kind !== "cloud") {
    return {
      url: `${workspaceSupervisorServerUrl()}/workspaces/${encodeURIComponent(workspace.id)}`,
      // A local workspace has no sandbox lease to read a region from, so the
      // deployment default is the best signal available.
      region: defaultHomeRegion(),
      release: () => {},
    }
  }
  const target = await sandboxManager.ensure(workspace.id, {
    // A Durable Object room keeps its placement after its creation.
    homeRegion: defaultHomeRegion(),
    hostId: input.hostId,
  })
  if (target.status !== "ready") throw new Error(`sandbox unavailable: ${workspace.id}`)
  holdSupervisorSandbox(workspace.id)
  return {
    // Only the tunnel connects to this address; clients use the relay.
    url: target.url,
    // An existing lease keeps its region when the deployment default changes.
    region: target.homeRegion,
    release: () => releaseSupervisorSandbox(workspace.id),
  }
}

export async function startWorkspaceHostTunnel(input: {
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
        region: target.region,
        tokenProvider: async () => token.current,
        localReplayHeaders: loopbackReplayHeaders,
        onEvent: (event) => logTunnelEvent({ workspaceId: input.workspaceId, hostId: input.hostId, relayUrl }, event),
        pingIntervalMs: 15_000,
        reconnectIntervalMs: 1_000,
        ...hostTunnelPreOpenQueueFromEnv(),
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
  log.info("workspace host tunnel started", {
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    relayUrl,
  })
  return {
    url: target.url,
    reused: false,
  }
}

export function stopWorkspaceHostTunnel(input: {
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

export function stopAllWorkspaceHostTunnels() {
  const count = tunnels.size
  for (const existing of tunnels.values()) {
    existing.tunnel.close()
    existing.release()
  }
  tunnels.clear()
  return count
}
