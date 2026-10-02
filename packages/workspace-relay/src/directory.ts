/**
 * One tunnel's presence, recorded once per workspace it serves. `workspaceIds`
 * is the full set that tunnel registered, so a reader that found the entry
 * through one workspace still sees the others.
 */
export type HostTunnelPresence = {
  hostId: string
  workspaceIds: string[]
  connectedAt: number
  lastPongAt: number
  expiresAt: number
}

/**
 * Presence is keyed by (host, workspace), so a later registration for a
 * workspace takes that workspace over without touching the host's other
 * entries. `recordPong` and `disconnectHost` act on every entry of the host.
 */
export type WorkspaceRelayDirectory = {
  registerHostTunnel(input: {
    hostId: string
    workspaceIds: string[]
  }): HostTunnelPresence
  recordPong(hostId: string): HostTunnelPresence | undefined
  disconnectHost(hostId: string): void
  activeHost(input: {
    hostId: string
    workspaceId: string
  }): HostTunnelPresence | undefined
}

function presenceKey(hostId: string, workspaceId: string) {
  return `${hostId}\0${workspaceId}`
}

export function createWorkspaceRelayDirectory(options: {
  ttlMs?: number
  now?: () => number
} = {}): WorkspaceRelayDirectory {
  const ttlMs = Math.max(1, options.ttlMs ?? 45_000)
  const now = options.now ?? Date.now
  const entries = new Map<string, HostTunnelPresence>()

  const alive = (key: string): HostTunnelPresence | undefined => {
    const presence = entries.get(key)
    if (!presence) return undefined
    if (presence.expiresAt <= now()) {
      entries.delete(key)
      return undefined
    }
    return presence
  }

  const keysOf = (hostId: string) =>
    [...entries].filter(([, presence]) => presence.hostId === hostId).map(([key]) => key)

  return {
    registerHostTunnel(input) {
      const timestamp = now()
      const next = {
        hostId: input.hostId,
        workspaceIds: [...new Set(input.workspaceIds)],
        connectedAt: timestamp,
        lastPongAt: timestamp,
        expiresAt: timestamp + ttlMs,
      }
      for (const workspaceId of next.workspaceIds) entries.set(presenceKey(next.hostId, workspaceId), next)
      return next
    },
    recordPong(hostId) {
      const timestamp = now()
      let touched: HostTunnelPresence | undefined
      for (const key of keysOf(hostId)) {
        const presence = alive(key)
        if (!presence) continue
        const next = { ...presence, lastPongAt: timestamp, expiresAt: timestamp + ttlMs }
        entries.set(key, next)
        touched ??= next
      }
      return touched
    },
    disconnectHost(hostId) {
      for (const key of keysOf(hostId)) entries.delete(key)
    },
    activeHost(input) {
      return alive(presenceKey(input.hostId, input.workspaceId))
    },
  }
}

