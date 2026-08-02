// Convex adapter for the @claxedo/wakes `WakeStore` port. A thin transport:
// every port operation maps 1:1 onto a
// service-token-guarded function in convex/wakes.ts, which returns rows
// already in the port's camelCase/null shape. Args are stripped of explicit
// nulls where Convex expects absent optionals; the tri-state `serialKey`
// (undefined | null | string) is passed through intact because the Convex
// validators accept string | null | undefined.
//
// Worker-safe: no node-only imports (bundles into the hosted control plane).

import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import type { SessionId, Token, Wake, WakeId, WakeState, WorkspaceId } from "@claxedo/wakes"
import type { WakeStore } from "@claxedo/wakes"

type Mutation = FunctionReference<"mutation">
type Query = FunctionReference<"query">

const api = anyApi as unknown as {
  wakes: {
    insertWake: Mutation
    claimDueWakes: Mutation
    reclaimFiringWakes: Mutation
    casWake: Mutation
    putWakeReceipt: Mutation
    gcWakes: Mutation
    getWake: Query
    getWakeByToken: Query
    getWakeByIdempotencyKey: Query
    findPendingWakesByEventKey: Query
    findExpirableWakes: Query
    findReclaimableWakes: Query
    listFiringWakes: Query
    listWakesForSession: Query
    countLiveWakes: Query
    countWakesCreatedSince: Query
    getWakeReceipt: Query
  }
}

export type ConvexWakeExecutor = {
  mutation: (fn: Mutation, args: Record<string, unknown>) => Promise<unknown>
  query: (fn: Query, args: Record<string, unknown>) => Promise<unknown>
}

export interface ConvexWakeStoreOptions {
  /** Convex deployment URL. Ignored when `executor` is injected (tests). */
  url?: string
  serviceToken: string
  executor?: ConvexWakeExecutor
  now?: () => number
}

function convexExecutor(url: string): ConvexWakeExecutor {
  const client = new ConvexHttpClient(url)
  return {
    mutation: (fn, args) => client.mutation(fn, args),
    query: (fn, args) => client.query(fn, args),
  }
}

/** Absent-optional normalization: Convex validators treat null and undefined
 * distinctly only for the tri-state serialKey; for wake fields both mean
 * "absent", and the validators accept either, so rows pass through as-is. */
export class ConvexWakeStore implements WakeStore {
  private readonly run: ConvexWakeExecutor
  private readonly token: string
  private readonly now: () => number

  constructor(options: ConvexWakeStoreOptions) {
    if (!options.executor && !options.url) throw new Error("ConvexWakeStore requires a url or an executor")
    this.run = options.executor ?? convexExecutor(options.url!)
    this.token = options.serviceToken
    this.now = options.now ?? Date.now
  }

  private args(extra: Record<string, unknown>): Record<string, unknown> {
    return { service_token: this.token, ...extra }
  }

  async insert(wake: Wake): Promise<{ inserted: boolean }> {
    return (await this.run.mutation(api.wakes.insertWake, this.args({ ...wake }))) as { inserted: boolean }
  }

  async get(id: WakeId): Promise<Wake | null> {
    return (await this.run.query(api.wakes.getWake, this.args({ id }))) as Wake | null
  }

  async getByToken(token: Token): Promise<Wake | null> {
    return (await this.run.query(api.wakes.getWakeByToken, this.args({ token }))) as Wake | null
  }

  async getByIdempotencyKey(workspaceId: WorkspaceId, key: string): Promise<Wake | null> {
    return (await this.run.query(
      api.wakes.getWakeByIdempotencyKey,
      this.args({ workspace_id: workspaceId, key }),
    )) as Wake | null
  }

  async claimDue(nowMs: number, leaseMs: number, limit: number, serialKey?: string | null): Promise<Wake[]> {
    return (await this.run.mutation(
      api.wakes.claimDueWakes,
      this.args({
        now: nowMs,
        lease_ms: leaseMs,
        limit,
        ...(serialKey === undefined ? {} : { serial_key: serialKey }),
      }),
    )) as Wake[]
  }

  async cas(id: WakeId, from: WakeState, to: WakeState, patch?: Partial<Wake>): Promise<boolean> {
    return (await this.run.mutation(
      api.wakes.casWake,
      this.args({ id, from, to, ...(patch ? { patch } : {}) }),
    )) as boolean
  }

  async findPendingByEventKey(eventKey: string): Promise<Wake[]> {
    return (await this.run.query(api.wakes.findPendingWakesByEventKey, this.args({ event_key: eventKey }))) as Wake[]
  }

  async findExpirable(nowMs: number): Promise<Wake[]> {
    return (await this.run.query(api.wakes.findExpirableWakes, this.args({ now: nowMs }))) as Wake[]
  }

  async findReclaimable(nowMs: number, serialKey?: string | null): Promise<Wake[]> {
    return (await this.run.query(
      api.wakes.findReclaimableWakes,
      this.args({ now: nowMs, ...(serialKey === undefined ? {} : { serial_key: serialKey }) }),
    )) as Wake[]
  }

  async reclaimFiring(nowMs: number, leaseMs: number, serialKey?: string | null): Promise<Wake[]> {
    return (await this.run.mutation(
      api.wakes.reclaimFiringWakes,
      this.args({ now: nowMs, lease_ms: leaseMs, ...(serialKey === undefined ? {} : { serial_key: serialKey }) }),
    )) as Wake[]
  }

  async listFiring(): Promise<Wake[]> {
    return (await this.run.query(api.wakes.listFiringWakes, this.args({}))) as Wake[]
  }

  async listForSession(sessionId: SessionId): Promise<Wake[]> {
    return (await this.run.query(api.wakes.listWakesForSession, this.args({ session_id: sessionId }))) as Wake[]
  }

  async countLive(workspaceId: WorkspaceId): Promise<number> {
    return (await this.run.query(api.wakes.countLiveWakes, this.args({ workspace_id: workspaceId }))) as number
  }

  async countCreatedSince(workspaceId: WorkspaceId, sinceMs: number): Promise<number> {
    return (await this.run.query(
      api.wakes.countWakesCreatedSince,
      this.args({ workspace_id: workspaceId, since: sinceMs }),
    )) as number
  }

  async getReceipt(key: string): Promise<string | null> {
    return (await this.run.query(api.wakes.getWakeReceipt, this.args({ key }))) as string | null
  }

  async putReceipt(key: string, resultJson: string): Promise<void> {
    await this.run.mutation(api.wakes.putWakeReceipt, this.args({ key, result_json: resultJson, now: this.now() }))
  }

  async gc(beforeMs: number): Promise<number> {
    return (await this.run.mutation(api.wakes.gcWakes, this.args({ before: beforeMs }))) as number
  }
}
