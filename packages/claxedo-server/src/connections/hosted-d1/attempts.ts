/**
 * The D1-backed implementation of the Connections kit's `Attempts` port.
 *
 * ## Why this exists
 *
 * The kit's attempt machine is an in-memory `Map`, and it says so: "Ephemeral
 * by design." That is a fine trade on a single local process. On the hosted
 * Worker control plane it is not a trade at all — the setup builds a fresh
 * `createConnectionsService` PER REQUEST, so the Map that `POST /:id/connect`
 * wrote the attempt into is already gone by the time `GET /attempts/:state`
 * runs. The poll read an empty Map on every request and answered
 * `attempt_not_found`, so hosted OAuth and device connect could never complete.
 * A durable table is what makes an attempt outlive its request.
 *
 * ## Semantics are the in-memory store's, not new ones
 *
 * Every rule below is ported deliberately rather than reinvented, because the
 * kit's own tests pin them and both stores must answer alike:
 *
 *   - `consume` is single-use and atomic — it flips `completing`, so a
 *     concurrent poll cannot settle the same attempt twice;
 *   - `peek` is the NON-consuming read device grants poll with, and it RECORDS
 *     an expiry it observes (otherwise a timed-out device attempt would read as
 *     pending forever and the client would poll to its own cap);
 *   - a pending row past its TTL is not consumable and reads as `expired`;
 *   - a MID-CONSUME row (`completing = 1`) is left pending past its TTL: only
 *     `settle` may move it, so a slow token exchange still reports its real
 *     outcome instead of a spurious "expired";
 *   - `expire` is distinct from `settle(false)`: only the former is worth
 *     restarting, and collapsing them would tell a user who merely took too
 *     long that authorization was refused.
 *
 * ## `now` is passed, not read from the database
 *
 * Same convention as the rest of the D1 adapters: the caller supplies the clock
 * so TTL arithmetic is reproducible and testable.
 */
import type { D1Database } from "@cloudflare/workers-types"
import type { Attempts } from "@claxedo/connections"

/** Mirrors the kit's `ttlMs` default: how long a pending attempt may be finished. */
export const HOSTED_ATTEMPT_TTL_MS = 10 * 60_000

/** Mirrors the kit's `retentionMs`: how long a settled attempt stays readable. */
export const HOSTED_ATTEMPT_RETENTION_MS = 5 * 60_000

/** Rows one sweep may retire. Bounds the statement's write set. */
export const HOSTED_ATTEMPT_SWEEP_LIMIT = 500

/**
 * Fraction of authenticated Connections requests that also run one retention
 * pass. There is no cron on this table, so the request path is the only thing
 * that can retire a row; sampling keeps the cost off the common request while
 * still bounding the table under any real traffic (a 5% sample retires up to
 * 500 rows every ~20 requests).
 */
export const HOSTED_ATTEMPT_SWEEP_RATE = 0.05

/**
 * The frozen owner and callback routing of ANY attempt row, terminal ones
 * included. `inspect` deliberately answers only for a live pending row, which
 * is right for a callback but wrong for the poll: an attempt that already
 * settled still has to be readable BY ITS OWNER and by no one else.
 */
export type HostedAttemptOwnership = Readonly<{
  owner: string | null
  routing?: Readonly<Record<string, string>>
}>

/** The durable store's own shape: the kit's port plus the ownership read above. */
export type HostedConnectionAttempts = Attempts & {
  ownership(state: string): Promise<HostedAttemptOwnership | undefined>
}

export type D1ConnectionAttemptsInput = Readonly<{
  database: D1Database
  now?: () => number
  /** Injectable for tests; defaults to Web Crypto, which the Worker runtime has. */
  newToken?: () => string
}>

type AttemptRecord = {
  state: string
  verifier: string
  integration_id: string
  device_code: string | null
  owner: string | null
  scope: "team" | "personal"
  context_json: string | null
  routing_json: string | null
  status: "pending" | "complete" | "failed" | "expired"
  completing: number
  message: string | null
  expires_at: number
}

const SELECT_COLUMNS = `
  state, verifier, integration_id, device_code, owner, scope,
  context_json, routing_json, status, completing, message, expires_at
`

/** 32 random bytes, base64url — the same shape and entropy the kit's store mints. */
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeRecord(value: string | null): Record<string, string> | undefined {
  if (value === null) return undefined
  return JSON.parse(value) as Record<string, string>
}

export function createD1ConnectionAttempts(input: D1ConnectionAttemptsInput): HostedConnectionAttempts {
  const now = input.now ?? Date.now
  const token = input.newToken ?? randomToken

  const read = (state: string) =>
    input.database
      .prepare(`select ${SELECT_COLUMNS} from hosted_connection_attempts where state = ?`)
      .bind(state)
      .first<AttemptRecord>()

  /** Move a pending row to `expired`, starting its retention window. */
  const markExpired = async (state: string, timestamp: number) => {
    await input.database
      .prepare(
        `
      update hosted_connection_attempts
      set status = 'expired', expires_at = ?, updated_at = ?
      where state = ? and status = 'pending'
    `,
      )
      .bind(timestamp + HOSTED_ATTEMPT_RETENTION_MS, timestamp, state)
      .run()
  }

  return {
    async create(attempt) {
      // Minted here rather than by the database so the row is keyed by a value
      // the caller already holds — the kit's in-memory store does the same, and
      // it keeps the write a pure insert with no return-value dependency.
      const state = token()
      const verifier = token()
      const timestamp = now()
      const result = await input.database
        .prepare(
          `
        insert into hosted_connection_attempts (
          state, verifier, integration_id, device_code, owner, scope,
          context_json, routing_json, status, completing, message,
          expires_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, null, ?, ?, ?)
        on conflict (state) do nothing
      `,
        )
        .bind(
          state,
          verifier,
          attempt.integrationId,
          attempt.deviceCode ?? null,
          attempt.owner ?? null,
          attempt.scope,
          attempt.context ? JSON.stringify(attempt.context) : null,
          attempt.routing ? JSON.stringify(attempt.routing) : null,
          timestamp + HOSTED_ATTEMPT_TTL_MS,
          timestamp,
          timestamp,
        )
        .run()
      // `state` is 32 random bytes; a collision is either a bug or a replay,
      // and either way the second write must not shadow the first.
      if ((result.meta.changes ?? 0) !== 1) throw new Error("Connection attempt already recorded")
      return { state, verifier }
    },

    async consume(state) {
      const timestamp = now()
      // The claim IS the guard: one statement flips `completing` only from a
      // live, unclaimed, pending row, so two isolates racing the same callback
      // cannot both win. Reading first and then writing would be a check-then-act
      // race with exactly the double-settle this fence exists to prevent.
      // `returning` hands back the row the claim actually won, so the winner
      // never re-reads: a second statement could only observe a LATER state
      // than the one it claimed.
      const claimed = await input.database
        .prepare(
          `
        update hosted_connection_attempts
        set completing = 1, updated_at = ?
        where state = ? and status = 'pending' and completing = 0 and expires_at > ?
        returning ${SELECT_COLUMNS}
      `,
        )
        .bind(timestamp, state, timestamp)
        .all<AttemptRecord>()
      const row = claimed.results[0]
      if (!row) {
        const current = await read(state)
        // Unknown, terminal, and mid-consume rows simply lose the claim. A
        // pending row the claim missed on its TTL is recorded expired here so
        // the next `status` read does not have to re-derive it.
        if (current && current.status === "pending" && current.completing === 0 && current.expires_at <= timestamp) {
          await markExpired(state, timestamp)
        }
        return undefined
      }
      return {
        integrationId: row.integration_id,
        ...(row.owner === null ? {} : { owner: row.owner }),
        scope: row.scope,
        verifier: row.verifier,
        ...(row.context_json === null ? {} : { context: decodeRecord(row.context_json)! }),
      }
    },

    async inspect(state) {
      const row = await read(state)
      if (!row || row.status !== "pending" || row.completing === 1 || row.expires_at <= now()) return undefined
      return {
        integrationId: row.integration_id,
        ...(row.owner === null ? {} : { owner: row.owner }),
        scope: row.scope,
        ...(row.routing_json === null ? {} : { routing: decodeRecord(row.routing_json)! }),
        ...(row.context_json === null ? {} : { context: decodeRecord(row.context_json)! }),
      }
    },

    /**
     * The authorization read. Unlike `inspect` it answers for a row in ANY
     * status, because the poll that has to be gated outlives the pending
     * window: the owner still asks "did it complete?" after the callback
     * settled the attempt. Carries no verifier, no device code, and no context.
     */
    async ownership(state) {
      const row = await input.database
        .prepare(`select owner, routing_json from hosted_connection_attempts where state = ?`)
        .bind(state)
        .first<{ owner: string | null; routing_json: string | null }>()
      if (!row) return undefined
      return {
        owner: row.owner,
        ...(row.routing_json === null ? {} : { routing: decodeRecord(row.routing_json)! }),
      }
    },

    async peek(state) {
      const row = await read(state)
      if (!row || row.status !== "pending" || row.device_code === null) return undefined
      const timestamp = now()
      if (row.expires_at <= timestamp) {
        await markExpired(state, timestamp)
        return undefined
      }
      return {
        integrationId: row.integration_id,
        ...(row.owner === null ? {} : { owner: row.owner }),
        scope: row.scope,
        deviceCode: row.device_code,
      }
    },

    async settle(state, ok, message) {
      const timestamp = now()
      await input.database
        .prepare(
          `
        update hosted_connection_attempts
        set status = ?, completing = 0, message = ?, expires_at = ?, updated_at = ?
        where state = ? and status = 'pending'
      `,
        )
        .bind(
          ok ? "complete" : "failed",
          message ?? null,
          timestamp + HOSTED_ATTEMPT_RETENTION_MS,
          timestamp,
          state,
        )
        .run()
    },

    async expire(state) {
      await markExpired(state, now())
    },

    async status(state) {
      const row = await read(state)
      if (!row) return undefined
      // A pending row past its TTL reads as `expired` WITHOUT being written
      // here: the sweep (or the next `consume`/`peek`) records it, and the
      // answer the client sees is the same either way.
      if (row.status === "pending" && row.completing === 0 && row.expires_at <= now()) {
        return { status: "expired" as const, integrationId: row.integration_id, scope: row.scope }
      }
      return {
        status: row.status,
        integrationId: row.integration_id,
        scope: row.scope,
        ...(row.status !== "pending" && row.message ? { message: row.message } : {}),
      }
    },

    /**
     * Retention. Level-triggered: a saturated pass leaves the rest for the next
     * one, and nothing is skipped forever because an expired row stays expired.
     *
     * A PENDING row past its TTL transitions to `expired` (starting its
     * retention window) rather than being deleted outright, so a client that
     * polls once more still learns why its attempt ended. Terminal rows past
     * retention are deleted. Mid-consume rows are skipped entirely — only
     * `settle` may move those.
     */
    async sweep() {
      const timestamp = now()
      const expired = await input.database
        .prepare(
          `
        update hosted_connection_attempts
        set status = 'expired', expires_at = ?, updated_at = ?
        where state in (
          select state from hosted_connection_attempts
          where status = 'pending' and completing = 0 and expires_at <= ?
          limit ?
        )
      `,
        )
        .bind(timestamp + HOSTED_ATTEMPT_RETENTION_MS, timestamp, timestamp, HOSTED_ATTEMPT_SWEEP_LIMIT)
        .run()
      const remaining = HOSTED_ATTEMPT_SWEEP_LIMIT - (expired.meta.changes ?? 0)
      if (remaining <= 0) return
      await input.database
        .prepare(
          `
        delete from hosted_connection_attempts
        where state in (
          select state from hosted_connection_attempts
          where status != 'pending' and expires_at <= ?
          limit ?
        )
      `,
        )
        .bind(timestamp, remaining)
        .run()
    },

    // There is no interval to clear and no isolate-local state to drop, so this
    // is a deliberate no-op — and it MUST stay one: the hosted setup calls it at
    // the end of every request, so anything destructive here would delete the
    // very attempt the next request has to find, reintroducing the bug this
    // store exists to fix.
    dispose() {},
  }
}
