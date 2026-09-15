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
 * Presence is keyed by (host, workspace): one host may hold a separate tunnel
 * per workspace on a Bun relay, and a later registration for a workspace takes
 * that workspace over without touching the host's other entries. `recordPong`
 * and `disconnectHost` take the optional workspace set for the same reason —
 * without it they act on every entry of the host, which is what a
 * single-workspace Cloudflare room wants.
 */
export type WorkspaceRelayDirectory = {
  registerHostTunnel(input: {
    hostId: string
    workspaceIds: string[]
  }): HostTunnelPresence
  recordPong(hostId: string, workspaceIds?: string[]): HostTunnelPresence | undefined
  disconnectHost(hostId: string, workspaceIds?: string[]): void
  activeHost(input: {
    hostId: string
    workspaceId: string
  }): HostTunnelPresence | undefined
  /**
   * Manually run an expiry sweep over the presence map. Removes any entry
   * whose `expiresAt <= now()`. Safe to call on a fresh/empty directory.
   * Useful in tests; the production path runs this on a timer (see
   * `sweepIntervalMs`).
   */
  sweep(): void
  /**
   * Stop the active sweep timer (if one was started). Safe to call multiple
   * times and on directories that were created with `sweepIntervalMs: 0`.
   */
  dispose(): void
  /**
   * Count of hosts with at least one non-expired presence entry, taken as a
   * snapshot without evicting. Surfaced via `/metrics` as
   * `directory.activeHostCount`.
   */
  size(): number
}

function presenceKey(hostId: string, workspaceId: string) {
  return `${hostId}\0${workspaceId}`
}

export function createWorkspaceRelayDirectory(options: {
  ttlMs?: number
  now?: () => number
  /**
   * Interval in milliseconds at which a background sweep runs to evict
   * expired host presence entries. Defaults to 30_000. Set to `0` to disable
   * the timer entirely (useful for tests; callers can still drive cleanup
   * manually via `sweep()`).
   */
  sweepIntervalMs?: number
} = {}): WorkspaceRelayDirectory {
  const ttlMs = Math.max(1, options.ttlMs ?? 45_000)
  const now = options.now ?? Date.now
  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000
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

  const keysOf = (hostId: string, workspaceIds: string[] | undefined) => {
    if (workspaceIds) return [...new Set(workspaceIds)].map((workspaceId) => presenceKey(hostId, workspaceId))
    return [...entries].filter(([, presence]) => presence.hostId === hostId).map(([key]) => key)
  }

  const sweep = () => {
    const at = now()
    for (const [key, presence] of entries) {
      if (presence.expiresAt <= at) {
        entries.delete(key)
      }
    }
  }

  let intervalHandle: ReturnType<typeof setInterval> | undefined
  if (sweepIntervalMs > 0) {
    intervalHandle = setInterval(sweep, sweepIntervalMs)
  }

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
    recordPong(hostId, workspaceIds) {
      const timestamp = now()
      let touched: HostTunnelPresence | undefined
      for (const key of keysOf(hostId, workspaceIds)) {
        const presence = alive(key)
        if (!presence) continue
        const next = { ...presence, lastPongAt: timestamp, expiresAt: timestamp + ttlMs }
        entries.set(key, next)
        touched ??= next
      }
      return touched
    },
    disconnectHost(hostId, workspaceIds) {
      for (const key of keysOf(hostId, workspaceIds)) entries.delete(key)
    },
    activeHost(input) {
      return alive(presenceKey(input.hostId, input.workspaceId))
    },
    sweep,
    size() {
      const at = now()
      const hosts = new Set<string>()
      for (const presence of entries.values()) {
        if (presence.expiresAt > at) hosts.add(presence.hostId)
      }
      return hosts.size
    },
    dispose() {
      if (intervalHandle !== undefined) {
        clearInterval(intervalHandle)
        intervalHandle = undefined
      }
    },
  }
}

/**
 * Convenience companion to `createWorkspaceRelayDirectory` for callers that
 * prefer a free function over a method. Equivalent to `directory.dispose()`.
 */
export function disposeWorkspaceRelayDirectory(directory: WorkspaceRelayDirectory): void {
  directory.dispose()
}
