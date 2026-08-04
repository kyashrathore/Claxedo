/**
 * The Convex-backed implementation of the Connections kit's `Attempts` port.
 *
 * ## Why this exists
 *
 * `@claxedo/connections`'s attempt machine is an in-memory `Map`, ephemeral by
 * design. On the hosted control plane that design does not hold: the Worker
 * builds a FRESH connections service per request
 * (`hosts/workgraph/hosted/connections-setup.ts`), so the Map that
 * `POST /:id/connect` wrote into no longer exists when `GET /attempts/:state`
 * runs one request later. Every hosted OAuth and device connect therefore
 * answered `attempt_not_found` — a hosted user could never finish connecting
 * GitHub, and so could never pick a repository when creating a cloud project.
 *
 * Backing the port with Convex makes an attempt survive the request that
 * created it, which is the whole requirement.
 *
 * ## Why the Executor rather than a fresh ConvexHttpClient
 *
 * The hosted connections setup is already handed the WorkGraph `Executor` and
 * service token, and reuses them for connection metadata. Threading the same
 * pair through here keeps ONE Convex seam per request — and, decisively, keeps
 * this unit testable with the same executor double the rest of the hosted
 * connections tests use, rather than requiring a live deployment URL.
 *
 * ## `now` is passed, not read server-side
 *
 * Same convention as `idempotency-store.ts` and `convex/orgs.ts`: the caller
 * supplies the clock so TTL arithmetic is reproducible and testable.
 */

import type { Attempts } from "@claxedo/connections"
import { anyApi, type FunctionReference } from "convex/server"

type Executor = Readonly<{
  query(fn: unknown, args: Record<string, unknown>): Promise<unknown>
  mutation(fn: unknown, args: Record<string, unknown>): Promise<unknown>
}>

type Query = FunctionReference<"query">
type Mutation = FunctionReference<"mutation">

const api = anyApi as unknown as {
  connectionAttempts: {
    create: Mutation
    consume: Mutation
    peek: Mutation
    settle: Mutation
    expire: Mutation
    status: Query
  }
}

export type ConvexConnectionAttemptsInput = Readonly<{
  executor: Executor
  serviceToken: string
  now?: () => number
  /** Injectable for tests; defaults to Web Crypto, which the Worker runtime has. */
  newToken?: () => string
}>

/** 32 random bytes, base64url — the same shape and entropy the kit's store mints. */
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

type PendingRow = Readonly<{
  integrationId: string
  owner?: string
  scope: "team" | "personal"
  verifier: string
}>

type DeviceRow = Readonly<{
  integrationId: string
  owner?: string
  scope: "team" | "personal"
  deviceCode: string
}>

type StatusRow = Readonly<{
  status: "pending" | "complete" | "failed" | "expired"
  integrationId: string
  scope: "team" | "personal"
  message?: string
}>

export function createConvexConnectionAttempts(input: ConvexConnectionAttemptsInput): Attempts {
  const now = input.now ?? Date.now
  const token = input.newToken ?? randomToken
  const service = { service_token: input.serviceToken }

  return {
    async create(attempt) {
      // Minted here rather than server-side so the row is keyed by a value the
      // caller already holds — the kit's in-memory store does the same, and it
      // keeps the mutation a pure write with no return-value dependency.
      const state = token()
      const verifier = token()
      await input.executor.mutation(api.connectionAttempts.create, {
        ...service,
        state,
        verifier,
        integration_id: attempt.integrationId,
        ...(attempt.deviceCode === undefined ? {} : { device_code: attempt.deviceCode }),
        ...(attempt.owner === undefined ? {} : { owner: attempt.owner }),
        scope: attempt.scope,
        now: now(),
      })
      return { state, verifier }
    },

    async consume(state) {
      const row = await input.executor.mutation(api.connectionAttempts.consume, {
        ...service,
        state,
        now: now(),
      }) as PendingRow | null
      return row ?? undefined
    },

    async peek(state) {
      const row = await input.executor.mutation(api.connectionAttempts.peek, {
        ...service,
        state,
        now: now(),
      }) as DeviceRow | null
      return row ?? undefined
    },

    async settle(state, ok, message) {
      await input.executor.mutation(api.connectionAttempts.settle, {
        ...service,
        state,
        ok,
        ...(message === undefined ? {} : { message }),
        now: now(),
      })
    },

    async expire(state) {
      await input.executor.mutation(api.connectionAttempts.expire, {
        ...service,
        state,
        now: now(),
      })
    },

    async status(state) {
      const row = await input.executor.query(api.connectionAttempts.status, {
        ...service,
        state,
        now: now(),
      }) as StatusRow | null
      return row ?? undefined
    },

    // Retention is the `sweepExpired` cron's job. There is no interval to clear
    // and no isolate-local state to drop, so both of these are deliberate
    // no-ops — and `dispose` MUST stay one: the hosted setup calls it at the end
    // of every request, so anything destructive here would delete the very
    // attempt the next request has to find, reintroducing the bug this store
    // exists to fix.
    sweep() {},
    dispose() {},
  }
}
