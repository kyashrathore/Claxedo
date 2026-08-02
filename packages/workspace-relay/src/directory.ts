export type HostTunnelPresence = {
  hostId: string
  workspaceIds: string[]
  connectedAt: number
  lastPongAt: number
  expiresAt: number
}

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
   * T31: count of currently-active (non-expired) host presence entries.
   * Equivalent to running `sweep()` then returning the residual map size, but
   * implemented as a single pass without mutating eviction state when the
   * caller only wants a snapshot. Surfaced via the `/metrics` endpoint as
   * `directory.activeHostCount`.
   */
  size(): number
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
  const hosts = new Map<string, HostTunnelPresence>()

  const alive = (presence: HostTunnelPresence | undefined) => {
    if (!presence) return
    if (presence.expiresAt <= now()) {
      hosts.delete(presence.hostId)
      return
    }
    return presence
  }

  const touch = (presence: HostTunnelPresence) => {
    const timestamp = now()
    const next = {
      ...presence,
      lastPongAt: timestamp,
      expiresAt: timestamp + ttlMs,
    }
    hosts.set(next.hostId, next)
    return next
  }

  const sweep = () => {
    const at = now()
    for (const [hostId, presence] of hosts) {
      if (presence.expiresAt <= at) {
        hosts.delete(hostId)
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
      hosts.set(next.hostId, next)
      return next
    },
    recordPong(hostId) {
      const presence = alive(hosts.get(hostId))
      return presence ? touch(presence) : undefined
    },
    disconnectHost(hostId) {
      hosts.delete(hostId)
    },
    activeHost(input) {
      const presence = alive(hosts.get(input.hostId))
      if (!presence?.workspaceIds.includes(input.workspaceId)) return
      return presence
    },
    sweep,
    size() {
      const at = now()
      let count = 0
      for (const presence of hosts.values()) {
        if (presence.expiresAt > at) count += 1
      }
      return count
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
