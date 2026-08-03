// Wakes-backed SettlementDispatcher: the same port hosted.ts already
// consumes, but the trigger becomes a durable
// dirty-flag wake plus a WakeLane DO nudge, instead of a WorkGraphSettler
// nudge. Flag-gated in worker.ts (CLAXEDO_WAKES_SETTLEMENT=1) so staging can
// prove the wakes path with instant rollback.
//
// Order matters: the wake row is created FIRST (durable — the 15-minute
// reconcile lane still backstops the outbox truth either way), then the DO is
// nudged. Both are fire-and-forget past the response via waitUntil.

import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { reportError } from "../../platform/telemetry/errors/report"
import { controlPlaneTimeoutMs, withTimeout } from "../../authority/adapters/convex/timeout"
import type { SettlementDispatcher } from "../workgraph/settlement-dispatcher"
import { dispatchWakeLaneNudge, type WakeLaneNamespace } from "../../platform/http/wake-lane-publish"
import { workGraphControlWake, workGraphSettleWake } from "./hosted-wakes"

type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as { wakes: { nudgeLaneWake: Mutation } }

export type WakeSettlementExecutor = {
  mutation: (fn: Mutation, args: Record<string, unknown>) => Promise<unknown>
}

export function createWakeSettlementDispatcher(input: Readonly<{
  namespace: WakeLaneNamespace
  waitUntil: (promise: Promise<unknown>) => void
  /** Convex deployment URL. Ignored when `executor` is injected (tests). */
  url?: string
  serviceToken: string
  executor?: WakeSettlementExecutor
  now?: () => number
  reportError?: typeof reportError
}>): SettlementDispatcher {
  if (!input.executor && !input.url) {
    throw new Error("createWakeSettlementDispatcher requires a Convex url or an executor")
  }
  const executor =
    input.executor ??
    (() => {
      const client = new ConvexHttpClient(input.url!)
      return {
        mutation: (fn: Mutation, args: Record<string, unknown>) => withTimeout(
          client.mutation(fn, args),
          controlPlaneTimeoutMs("mutation"),
        ),
      }
    })()
  const now = input.now ?? Date.now
  const errorReporter = input.reportError ?? reportError
  const report = (error: unknown) => {
    try {
      errorReporter(error, { tags: { source: "wake_settlement_dispatcher" } })
    } catch {
      // A nudge and its reporting are advisory. Neither may affect the command response.
    }
  }
  type WakeShape = Readonly<{
    kind: string
    serialKey: string
    workspaceId: string
    at: number
    intent: Parameters<SettlementDispatcher["nudge"]>[0]
  }>
  const dispatch = (shapeFor: (t: number) => WakeShape) => {
    try {
      input.waitUntil(
        (async () => {
          const t = now()
          const shape = shapeFor(t)
          await executor.mutation(api.wakes.nudgeLaneWake, {
            service_token: input.serviceToken,
            id: `wake_${crypto.randomUUID()}`,
            sessionId: null,
            workspaceId: shape.workspaceId,
            triggerType: "at",
            kind: shape.kind,
            serialKey: shape.serialKey,
            intentJson: JSON.stringify(shape.intent),
            resultJson: null,
            state: "pending",
            expiresAt: null,
            depth: 0,
            createdBy: "wake-settlement-dispatcher",
            createdAt: t,
            firedAt: null,
            fireAt: shape.at,
            schedule: null,
            eventKey: null,
            token: null,
            prompt: null,
            resolvedBy: null,
            idempotencyKey: null,
            leaseUntil: null,
            attempts: 0,
          })
          await dispatchWakeLaneNudge(input.namespace, { serialKey: shape.serialKey, fireAt: t })
        })().catch(report),
      )
    } catch (error) {
      report(error)
    }
  }
  return {
    nudge(tenant) {
      dispatch((t) => workGraphSettleWake(tenant, t))
    },
    nudgeControl(tenant) {
      dispatch((t) => workGraphControlWake(tenant, t))
    },
  }
}
