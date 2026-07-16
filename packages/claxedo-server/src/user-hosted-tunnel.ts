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
import { RouteHandler, routeOwnership } from "./route-ownership"

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
const machineTunnels = new Map<string, {
  tunnel: WorkspaceRelayHostTunnel
  hostId: string
  relayUrl: string
  token: { current: string }
  workspaceIds: string[]
}>()

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

export async function startUserHostedMachineTunnel(input: {
  workspaceIds: string[]
  hostId: string
  relayUrl: string
  hostTunnelToken: string
}) {
  const workspaceIds = [...new Set(input.workspaceIds)].sort()
  if (!workspaceIds.length) throw new Error("At least one local workspace is required")
  const workspaces = await Promise.all(workspaceIds.map((workspaceId) => getWorkspace(workspaceId)))
  const invalid = workspaces.find((workspace) => !workspace || workspace.kind !== "local")
  if (invalid !== undefined || workspaces.some((workspace) => !workspace)) {
    throw new Error("Machine-wide remote access supports local workspaces only")
  }

  const relayUrl = normalized(input.relayUrl)
  const existing = machineTunnels.get(input.hostId)
  if (existing?.relayUrl === relayUrl) {
    existing.token.current = input.hostTunnelToken
    if (existing.workspaceIds.join("\n") !== workspaceIds.join("\n")) {
      await existing.tunnel.updateRegistration({
        workspaceIds,
        token: input.hostTunnelToken,
      })
      existing.workspaceIds = workspaceIds
    }
    return { reused: true, connectionCount: 1, workspaceIds }
  }

  existing?.tunnel.close()
  const token = { current: input.hostTunnelToken }
  const localBaseUrl = workspaceSupervisorServerUrl()
  const tunnel = startWorkspaceRelayHostTunnel({
    relayUrl,
    hostId: input.hostId,
    workspaceIds,
    localBaseUrl,
    resolveLocalUrl: ({ workspaceId, path }) => {
      // The relay carries only workspace-runtime traffic. CentralServer-owned
      // routes remain loopback-only even when a malicious relay asks for one.
      if (routeOwnership(new URL(path, "http://workspace.local").pathname).handler !== RouteHandler.SandboxRuntime) return
      return new URL(
        `/workspaces/${encodeURIComponent(workspaceId)}/${path.replace(/^\/+/, "")}`,
        `${normalized(localBaseUrl)}/`,
      )
    },
    tokenProvider: async () => token.current,
    onEvent: (event) => logTunnelEvent({ workspaceId: workspaceIds.join(","), hostId: input.hostId, relayUrl }, event),
    pingIntervalMs: 15_000,
    reconnectIntervalMs: 1_000,
  })
  machineTunnels.set(input.hostId, {
    tunnel,
    hostId: input.hostId,
    relayUrl,
    token,
    workspaceIds,
  })
  log.info("user-hosted machine tunnel started", {
    hostId: input.hostId,
    relayUrl,
    workspaceIds,
  })
  return { reused: false, connectionCount: 1, workspaceIds }
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

export function stopUserHostedMachineTunnel(hostId: string) {
  const existing = machineTunnels.get(hostId)
  if (!existing) return false
  existing.tunnel.close()
  machineTunnels.delete(hostId)
  return true
}

export function stopAllUserHostedWorkspaceTunnels() {
  const count = tunnels.size + machineTunnels.size
  for (const existing of tunnels.values()) {
    existing.tunnel.close()
    existing.release()
  }
  tunnels.clear()
  for (const existing of machineTunnels.values()) existing.tunnel.close()
  machineTunnels.clear()
  return count
}
