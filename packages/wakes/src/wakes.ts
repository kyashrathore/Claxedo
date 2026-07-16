import { ulid } from "ulid"
import type {
  Actor,
  Authorize,
  Budgets,
  ComputeNextRun,
  Json,
  ResolveOutcome,
  SessionId,
  SpawnTurn,
  Token,
  Wake,
  WakeDriver,
  WakeId,
  WakeResult,
  WakeSink,
  WorkspaceId,
} from "./types"
import type { WakeStore } from "./store"
import { enforceBudgets, resolveBudgets } from "./budgets"
import { generateToken } from "./token"

export interface CreateWakesOptions {
  store: WakeStore
  /** Sugar for `sinks.session_turn`: fire by resuming the wake's session. */
  spawnTurn?: SpawnTurn
  /**
   * Firing handlers keyed by wake `kind`. A wake whose kind has no registered
   * sink fails its fire (the row stays reclaimable) instead of firing wrong.
   */
  sinks?: Record<string, WakeSink>
  /**
   * Push driver: hinted after every time-triggered create so firing needn't
   * wait for the polling sweep. Optional — without one, behavior is exactly
   * the polled `runDue()` loop.
   */
  driver?: WakeDriver
  authorize?: Authorize
  budgets?: Budgets
  /** Injectable clock (epoch ms). Default `Date.now`. */
  now?: () => number
  /** Cron parser; required only if any wake uses `cron`. */
  computeNextRun?: ComputeNextRun
  /** Lease duration for a `firing` row before it is reclaimable. Default 30_000. */
  leaseMs?: number
  /** Max due `at` wakes claimed per `runDue()`. Default 100. */
  batchLimit?: number
}

type CommonCreate = {
  sessionId?: SessionId | null
  workspaceId: WorkspaceId
  /** Which sink fires this wake. Default "session_turn". */
  kind?: string
  /** Serialization lane: same-key wakes never fire concurrently. Default none. */
  serialKey?: string
  intent?: Json
  idempotencyKey?: string
  createdBy?: string
  depth?: number
  expiresAt?: number | Date
}

export interface Wakes {
  schedule(input: CommonCreate & { at?: number | Date; cron?: string }): Promise<{ wakeId: WakeId }>
  watch(input: CommonCreate & { eventKey: string }): Promise<{ wakeId: WakeId }>
  requestApproval(input: CommonCreate & { prompt: string; expiresAt: number | Date }): Promise<{
    token: Token
    wakeId: WakeId
  }>
  cancel(wakeIdOrToken: string): Promise<void>
  resolve(token: Token, answer: string, resolver: Actor): Promise<ResolveOutcome>
  deliverEvent(eventKey: string, payload: Json, deliveryId?: string): Promise<{ fired: number }>
  /**
   * Fire due wakes. With `serialKey` (string = that lane, null = null-key
   * wakes) the run is lane-scoped for a push driver: it reclaims and claims
   * only that lane and skips the expiry sweep. Without it, the full polled
   * pass runs (expiry + reclaim + claim across all lanes).
   */
  runDue(serialKey?: string | null): Promise<{ fired: number }>
  /** Boot sweep: re-drive every `firing` row left by a crash. Call on startup. */
  recover(): Promise<{ recovered: number }>
  once<T>(sessionId: SessionId, effectKey: string, fn: () => Promise<T> | T): Promise<T>
  listForSession(sessionId: SessionId): Promise<Wake[]>
  gc(olderThanMs: number): Promise<number>
}

const toMs = (v: number | Date | undefined | null): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : v

export function createWakes(opts: CreateWakesOptions): Wakes {
  const { store, spawnTurn, computeNextRun, driver } = opts
  const authorize = opts.authorize ?? (() => true)
  const now = opts.now ?? Date.now
  const limits = resolveBudgets(opts.budgets)
  const leaseMs = opts.leaseMs ?? 30_000
  const batchLimit = opts.batchLimit ?? 100
  const sinks: Record<string, WakeSink> = {
    ...(spawnTurn ? { session_turn: (wake, result) => spawnTurn(wake.sessionId, result) } : {}),
    ...opts.sinks,
  }
  if (Object.keys(sinks).length === 0) {
    throw new Error("createWakes requires spawnTurn or at least one sink")
  }

  // Resolve BEFORE any side effect: an unregistered kind must fail the fire
  // while the row is still recoverable, never half-fire.
  function sinkFor(wake: Wake): WakeSink {
    const sink = sinks[wake.kind]
    if (!sink) throw new Error(`no sink registered for wake kind "${wake.kind}"`)
    return sink
  }

  function resultForWake(wake: Wake): WakeResult {
    if (wake.resultJson) return JSON.parse(wake.resultJson) as WakeResult
    return { trigger: "at", intent: JSON.parse(wake.intentJson) }
  }

  // Lossy hint, never load-bearing: a throwing driver must not fail the
  // create — the row is durable and the polling sweep will deliver it.
  function nudge(serialKey: string | null, fireAt: number): void {
    try {
      driver?.nudge({ serialKey, fireAt })
    } catch {
      // the sweep is the backstop
    }
  }

  // A wake in `firing`: run its sink (at-least-once), record `fired`, and for a
  // recurring `at` wake, enqueue the next occurrence idempotently.
  async function driveFiring(wake: Wake): Promise<void> {
    await sinkFor(wake)(wake, resultForWake(wake))
    await store.cas(wake.id, "firing", "fired", { firedAt: now(), leaseUntil: null })
    if (wake.triggerType === "at" && wake.schedule) {
      if (!computeNextRun) throw new Error("recurring wake requires the computeNextRun option")
      const nextFireAt = computeNextRun(wake.schedule, wake.fireAt ?? now())
      await insertWake(
        {
          triggerType: "at",
          sessionId: wake.sessionId,
          workspaceId: wake.workspaceId,
          kind: wake.kind,
          serialKey: wake.serialKey ?? undefined,
          intentJson: wake.intentJson,
          fireAt: nextFireAt,
          schedule: wake.schedule,
          depth: wake.depth,
          createdBy: wake.createdBy,
          idempotencyKey: `recur:${wake.id}:${nextFireAt}`,
        },
        { skipBudget: true },
      )
      nudge(wake.serialKey, nextFireAt)
    }
  }

  // pending → firing (the guard) → drive. Returns false if the guard failed.
  async function fireFromPending(wake: Wake, resultJson: string, patch?: Partial<Wake>): Promise<boolean> {
    const ok = await store.cas(wake.id, "pending", "firing", { resultJson, leaseUntil: now() + leaseMs, ...patch })
    if (!ok) return false
    await driveFiring((await store.get(wake.id))!)
    return true
  }

  async function insertWake(
    fields: Partial<Wake> & { workspaceId: WorkspaceId; triggerType: Wake["triggerType"] },
    o?: { skipBudget?: boolean },
  ): Promise<{ wakeId: WakeId }> {
    const t = now()
    if (!o?.skipBudget) {
      await enforceBudgets(store, limits, {
        workspaceId: fields.workspaceId,
        depth: fields.depth ?? 0,
        fireAt: fields.fireAt ?? null,
        nowMs: t,
      })
    }
    if (fields.idempotencyKey) {
      const existing = await store.getByIdempotencyKey(fields.workspaceId, fields.idempotencyKey)
      if (existing) return { wakeId: existing.id }
    }
    const wake: Wake = {
      id: `wake_${ulid()}`,
      sessionId: fields.sessionId ?? null,
      workspaceId: fields.workspaceId,
      triggerType: fields.triggerType,
      kind: fields.kind ?? "session_turn",
      serialKey: fields.serialKey ?? null,
      intentJson: fields.intentJson ?? "null",
      resultJson: null,
      state: "pending",
      expiresAt: fields.expiresAt ?? null,
      depth: fields.depth ?? 0,
      createdBy: fields.createdBy ?? null,
      createdAt: t,
      firedAt: null,
      fireAt: fields.fireAt ?? null,
      schedule: fields.schedule ?? null,
      eventKey: fields.eventKey ?? null,
      token: fields.token ?? null,
      prompt: fields.prompt ?? null,
      resolvedBy: null,
      idempotencyKey: fields.idempotencyKey ?? null,
      leaseUntil: null,
      attempts: 0,
    }
    const { inserted } = await store.insert(wake)
    if (!inserted && fields.idempotencyKey) {
      const existing = await store.getByIdempotencyKey(fields.workspaceId, fields.idempotencyKey)
      if (existing) return { wakeId: existing.id }
    }
    return { wakeId: wake.id }
  }

  return {
    async schedule(input) {
      const t = now()
      let fireAt: number
      let schedule: string | null = null
      if (input.at != null) {
        fireAt = toMs(input.at)!
      } else if (input.cron) {
        if (!computeNextRun) throw new Error("cron schedule requires the computeNextRun option")
        fireAt = computeNextRun(input.cron, t)
        schedule = input.cron
      } else {
        throw new Error("schedule requires `at` or `cron`")
      }
      const created = await insertWake({
        triggerType: "at",
        sessionId: input.sessionId ?? null,
        workspaceId: input.workspaceId,
        kind: input.kind,
        serialKey: input.serialKey,
        intentJson: JSON.stringify(input.intent ?? null),
        fireAt,
        schedule,
        expiresAt: toMs(input.expiresAt) ?? undefined,
        depth: input.depth,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      })
      nudge(input.serialKey ?? null, fireAt)
      return created
    },

    async watch(input) {
      return insertWake({
        triggerType: "on_event",
        sessionId: input.sessionId ?? null,
        workspaceId: input.workspaceId,
        kind: input.kind,
        serialKey: input.serialKey,
        intentJson: JSON.stringify(input.intent ?? null),
        eventKey: input.eventKey,
        expiresAt: toMs(input.expiresAt) ?? undefined,
        depth: input.depth,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      })
    },

    async requestApproval(input) {
      const { wakeId } = await insertWake({
        triggerType: "on_approval",
        sessionId: input.sessionId ?? null,
        workspaceId: input.workspaceId,
        kind: input.kind,
        serialKey: input.serialKey,
        intentJson: JSON.stringify(input.intent ?? null),
        prompt: input.prompt,
        token: generateToken(),
        expiresAt: toMs(input.expiresAt)!,
        depth: input.depth,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      })
      // On an idempotent hit the returned wake carries the original token.
      return { token: (await store.get(wakeId))!.token!, wakeId }
    },

    async cancel(wakeIdOrToken) {
      const wake = (await store.get(wakeIdOrToken)) ?? (await store.getByToken(wakeIdOrToken))
      if (wake) await store.cas(wake.id, "pending", "cancelled", { firedAt: now() })
    },

    async resolve(token, answer, resolver) {
      const wake = await store.getByToken(token)
      if (!wake) return { ok: false, reason: "not_found" }
      if (wake.state === "expired") return { ok: false, reason: "too_late" }
      if (wake.state !== "pending") return { ok: false, reason: "already_resolved" }
      if (!(await authorize(resolver, wake.workspaceId))) return { ok: false, reason: "unauthorized" }
      const result: WakeResult = { trigger: "on_approval", answer, resolvedBy: resolver }
      const ok = await fireFromPending(wake, JSON.stringify(result), { resolvedBy: JSON.stringify(resolver) })
      if (ok) return { ok: true }
      return {
        ok: false,
        reason: (await store.get(wake.id))?.state === "expired" ? "too_late" : "already_resolved",
      }
    },

    async deliverEvent(eventKey, payload) {
      let fired = 0
      for (const wake of await store.findPendingByEventKey(eventKey)) {
        const result: WakeResult = { trigger: "on_event", intent: JSON.parse(wake.intentJson), payload }
        if (await fireFromPending(wake, JSON.stringify(result))) fired++
      }
      return { fired }
    },

    async runDue(serialKey) {
      const t = now()
      let fired = 0
      if (serialKey === undefined) {
        for (const wake of await store.findExpirable(t)) {
          // Resolve the sink before the terminal CAS so an unregistered kind
          // cannot silently swallow the gave-up notification.
          const sink = sinkFor(wake)
          if (await store.cas(wake.id, "pending", "expired", { firedAt: t })) {
            await sink(wake, {
              trigger: "at",
              intent: JSON.parse(wake.intentJson),
              expired: true,
            })
            fired++
          }
        }
      }
      for (const wake of await store.findReclaimable(t, serialKey)) {
        await driveFiring(wake)
        fired++
      }
      for (const wake of await store.claimDue(t, leaseMs, batchLimit, serialKey)) {
        await driveFiring(wake)
        fired++
      }
      return { fired }
    },

    async recover() {
      let recovered = 0
      for (const wake of await store.listFiring()) {
        await driveFiring(wake)
        recovered++
      }
      return { recovered }
    },

    async once(sessionId, effectKey, fn) {
      const key = `${sessionId}::${effectKey}`
      const cached = await store.getReceipt(key)
      if (cached !== null) return JSON.parse(cached)
      const result = await fn()
      await store.putReceipt(key, JSON.stringify(result ?? null))
      return result
    },

    async listForSession(sessionId) {
      return store.listForSession(sessionId)
    },

    async gc(olderThanMs) {
      return store.gc(now() - olderThanMs)
    },
  }
}
