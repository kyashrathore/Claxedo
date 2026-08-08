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
import { getWorkspace } from "./workspace/store"
import { RouteHandler, routeOwnership } from "./platform/governance/route-ownership"

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
  token: { current: () => Promise<string> }
  workspaceIds: string[]
  registration: { current: Set<string> }
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
      // A local workspace has no sandbox lease to read a region from, so the
      // deployment default is the best signal available.
      region: defaultHomeRegion(),
      release: () => {},
    }
  }
  const target = await sandboxManager.ensure(workspace.id, {
    // Was hardcoded "us-east". See the note in
    // workspace-supervisor-sandbox.ts: the relay derives its Durable Object
    // location hint from this region, and that placement is permanent.
    homeRegion: defaultHomeRegion(),
    hostId: input.hostId,
  })
  if (target.status !== "ready") throw new Error(`sandbox unavailable: ${workspace.id}`)
  holdSupervisorSandbox(workspace.id)
  return {
    // `localBaseUrl` is the Node-side bridge ingress used by the Relay host
    // tunnel. Product traffic still enters through Relay; this direct URL is
    // not exposed as a client/control-plane target.
    url: target.url,
    // The LEASE's region, not the config default: for a workspace that already
    // exists, its recorded region is authoritative and may predate the current
    // CLAXEDO_HOME_REGION setting.
    region: target.homeRegion,
    release: () => releaseSupervisorSandbox(workspace.id),
  }
}

export async function startUserHostedMachineTunnel(input: {
  workspaceIds: string[]
  hostId: string
  relayUrl: string
} & (
  | { hostTunnelTokenProvider: () => Promise<string>; hostTunnelToken?: never }
  | { hostTunnelToken: string; hostTunnelTokenProvider?: never }
)) {
  const workspaceIds = [...new Set(input.workspaceIds)].sort()
  if (!workspaceIds.length) throw new Error("At least one local workspace is required")
  const workspaces = await Promise.all(workspaceIds.map((workspaceId) => getWorkspace(workspaceId)))
  const invalid = workspaces.find((workspace) => !workspace || workspace.kind !== "local")
  if (invalid !== undefined || workspaces.some((workspace) => !workspace)) {
    throw new Error("Machine-wide remote access supports local workspaces only")
  }

  const relayUrl = normalized(input.relayUrl)
  const hostTunnelTokenProvider = input.hostTunnelTokenProvider ?? (async () => input.hostTunnelToken)
  const existing = machineTunnels.get(input.hostId)
  if (existing?.relayUrl === relayUrl) {
    existing.token.current = hostTunnelTokenProvider
    if (existing.workspaceIds.join("\n") !== workspaceIds.join("\n")) {
      await existing.tunnel.updateRegistration({
        workspaceIds,
        token: await hostTunnelTokenProvider(),
      })
      existing.workspaceIds = workspaceIds
      existing.registration.current = new Set(workspaceIds)
    }
    return { reused: true, connectionCount: 1, workspaceIds }
  }

  existing?.tunnel.close()
  const token = { current: hostTunnelTokenProvider }
  const registration = { current: new Set(workspaceIds) }
  const localBaseUrl = workspaceSupervisorServerUrl()
  const tunnel = startWorkspaceRelayHostTunnel({
    relayUrl,
    hostId: input.hostId,
    workspaceIds,
    localBaseUrl,
    // Lets the relay place this workspace's Durable Object near its users
    // instead of on the deployment-wide default. Permanent once the DO exists.
    region: defaultHomeRegion(),
    resolveLocalUrl: ({ workspaceId, path }) => {
      // The relay carries only workspace-runtime traffic. CentralServer-owned
      // routes remain loopback-only even when a malicious relay asks for one.
      if (!registration.current.has(workspaceId)) return
      if (routeOwnership(new URL(path, "http://workspace.local").pathname).handler !== RouteHandler.SandboxRuntime) return
      return new URL(
        `/workspaces/${encodeURIComponent(workspaceId)}/${path.replace(/^\/+/, "")}`,
        `${normalized(localBaseUrl)}/`,
      )
    },
    tokenProvider: () => token.current(),
    onEvent: (event) => logTunnelEvent({ workspaceId: workspaceIds.join(","), hostId: input.hostId, relayUrl }, event),
    pingIntervalMs: 15_000,
    reconnectIntervalMs: 1_000,
    ...hostTunnelPreOpenQueueFromEnv(),
  })
  machineTunnels.set(input.hostId, {
    tunnel,
    hostId: input.hostId,
    relayUrl,
    token,
    workspaceIds,
    registration,
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
        region: target.region,
        tokenProvider: async () => token.current,
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

export function hasUserHostedMachineTunnel(hostId: string) {
  return machineTunnels.has(hostId)
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
