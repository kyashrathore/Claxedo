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
  createdAt: number
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
  create(input: { integrationId: string; owner?: string; scope: "team" | "personal" }): { state: string; verifier: string }
  // Atomic consume: returns the pending entry exactly once (flips
  // `completing`); unknown, expired, terminal, or already-consuming states
  // return undefined.
  consume(state: string): { integrationId: string; owner?: string; scope: "team" | "personal"; verifier: string } | undefined
  settle(state: string, ok: boolean, message?: string): void
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
      if (entry.status === "pending" && entry.expiresAt <= ts) {
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
      const ts = now()
      map.set(state, {
        status: "pending",
        completing: false,
        verifier,
        integrationId: input.integrationId,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        scope: input.scope,
        createdAt: ts,
        expiresAt: ts + ttlMs,
      })
      return { state, verifier }
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
