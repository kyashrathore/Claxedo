// OAuth attempt machine — plain-TS port of the upstream v2 design
// (packages/core/src/integration.ts): in-memory map, atomic consume via a
// `completing` flag, 30s sweep expiring pending rows past TTL and deleting
// terminal rows past retention. Ephemeral by design: a host restart drops
// pending attempts; the callback then hits the unknown-state rejection and
// the user retries a seconds-long, user-initiated flow.
import { randomBytes } from "node:crypto"
import type { AttemptStatus } from "./types.js"

type PendingEntry = {
  status: "pending"
  completing: boolean
  verifier: string
  integrationId: string
  owner?: string
  scope: "team" | "personal"
  // Present only for device grants: the provider-issued code the host polls
  // with. A redirect attempt has no equivalent — its code arrives on the
  // callback instead.
  deviceCode?: string
  expiresAt: number
}
type TerminalEntry = {
  status: "complete" | "failed" | "expired"
  integrationId: string
  owner?: string
  scope: "team" | "personal"
  message?: string
  removeAt: number
}
type AttemptEntry = PendingEntry | TerminalEntry

export type Attempts = {
  create(input: { integrationId: string; owner?: string; scope: "team" | "personal"; deviceCode?: string }): { state: string; verifier: string }
  // Atomic consume: returns the pending entry exactly once (flips
  // `completing`); unknown, expired, terminal, or already-consuming states
  // return undefined.
  consume(state: string): { integrationId: string; owner?: string; scope: "team" | "personal"; verifier: string } | undefined
  // Non-consuming read for device grants, which poll the SAME attempt many
  // times before it settles. `consume` cannot serve this: it is single-use by
  // design, so the second poll would report a lost attempt.
  peek(state: string): { integrationId: string; owner?: string; scope: "team" | "personal"; deviceCode: string } | undefined
  settle(state: string, ok: boolean, message?: string): void
  // Settles an attempt the PROVIDER declared expired, as distinct from one
  // that failed. Only the former is worth restarting, and the two carry
  // different copy, so collapsing them into `settle(false)` would tell a user
  // who merely took too long that authorization was refused.
  expire(state: string): void
  status(state: string): { status: AttemptStatus; integrationId: string; scope: "team" | "personal"; message?: string } | undefined
  sweep(): void
  dispose(): void
}

export function createAttempts(options: {
  ttlMs?: number
  retentionMs?: number
  now?: () => number
  sweepIntervalMs?: number
} = {}): Attempts {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 10 * 60_000
  const retentionMs = options.retentionMs ?? 5 * 60_000
  const map = new Map<string, AttemptEntry>()

  const sweep = () => {
    const ts = now()
    for (const [state, entry] of map) {
      // A mid-consume entry (`completing: true`) is left pending past its TTL:
      // only `settle` may move it, so a slow token exchange still reports its
      // real outcome instead of a spurious "expired".
      if (entry.status === "pending" && !entry.completing && entry.expiresAt <= ts) {
        map.set(state, {
          status: "expired",
          integrationId: entry.integrationId,
          ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
          scope: entry.scope,
          removeAt: ts + retentionMs,
        })
        continue
      }
      if (entry.status !== "pending" && entry.removeAt <= ts) map.delete(state)
    }
  }

  const interval = options.sweepIntervalMs === 0
    ? undefined
    : setInterval(sweep, options.sweepIntervalMs ?? 30_000)
  interval?.unref?.()

  return {
    create(input) {
      const state = randomBytes(32).toString("base64url")
      const verifier = randomBytes(32).toString("base64url")
      map.set(state, {
        status: "pending",
        completing: false,
        verifier,
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        scope: input.scope,
        ...(input.deviceCode !== undefined ? { deviceCode: input.deviceCode } : {}),
        expiresAt: now() + ttlMs,
      })
      return { state, verifier }
    },
    peek(state) {
      const entry = map.get(state)
      if (!entry || entry.status !== "pending" || entry.deviceCode === undefined) return undefined
      if (entry.expiresAt <= now()) {
        map.set(state, {
          status: "expired",
          integrationId: entry.integrationId,
          ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
          scope: entry.scope,
          removeAt: now() + retentionMs,
        })
        return undefined
      }
      return {
        integrationId: entry.integrationId,
        ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
        scope: entry.scope,
        deviceCode: entry.deviceCode,
      }
    },
    consume(state) {
      const entry = map.get(state)
      if (!entry || entry.status !== "pending" || entry.completing) return undefined
      if (entry.expiresAt <= now()) {
        map.set(state, {
          status: "expired",
          integrationId: entry.integrationId,
          ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
          scope: entry.scope,
          removeAt: now() + retentionMs,
        })
        return undefined
      }
      entry.completing = true
      return {
        integrationId: entry.integrationId,
        ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
        scope: entry.scope,
        verifier: entry.verifier,
      }
    },
    settle(state, ok, message) {
      const entry = map.get(state)
      if (!entry || entry.status !== "pending") return
      map.set(state, {
        status: ok ? "complete" : "failed",
        integrationId: entry.integrationId,
        ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
        scope: entry.scope,
        ...(message ? { message } : {}),
        removeAt: now() + retentionMs,
      })
    },
    expire(state) {
      const entry = map.get(state)
      if (!entry || entry.status !== "pending") return
      map.set(state, {
        status: "expired",
        integrationId: entry.integrationId,
        ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
        scope: entry.scope,
        removeAt: now() + retentionMs,
      })
    },
    status(state) {
      const entry = map.get(state)
      if (!entry) return undefined
      return {
        status: entry.status,
        integrationId: entry.integrationId,
        scope: entry.scope,
        ...(entry.status !== "pending" && entry.message ? { message: entry.message } : {}),
      }
    },
    sweep,
    dispose() {
      if (interval) clearInterval(interval)
      map.clear()
    },
  }
}
