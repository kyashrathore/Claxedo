/**
 * W4.4 — the Convex adapter behind `CronLease` (`convex/cronLease.ts`).
 *
 * Same convention as this directory's other adapters: service-token mutations
 * over `ConvexHttpClient`, each wrapped in `withTimeout`, with `now` passed in
 * rather than read inside the mutation.
 *
 * `acquire` and `release` are both retry-safe — re-acquiring a lease this holder
 * already owns is a renewal, and a duplicate release is fence-checked into a
 * no-op — so they inherit the W4.1 retry. Which matters more here than on most
 * paths: a lease call that fails on a transient blip would silently skip a cron
 * tick, and skipped cron ticks are exactly the class of failure nobody notices.
 */

import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import type { CronLease } from "../../../hosts/workgraph/reconcile-serialize"
import { controlPlaneTimeoutMs, withTimeout } from "./timeout"
import { withConvexRetry } from "./retry"

type CronLeaseApi = {
  cronLease: {
    acquire: FunctionReference<"mutation">
    heartbeat: FunctionReference<"mutation">
    release: FunctionReference<"mutation">
  }
}

const cronLeaseApi = anyApi as unknown as CronLeaseApi

export type ConvexCronLeaseInput = {
  url: string
  serviceToken: string
  env?: Record<string, string | undefined>
  now?: () => number
  leaseMs?: number
}

export function createConvexCronLease(input: ConvexCronLeaseInput): CronLease {
  const now = input.now ?? (() => Date.now())
  const env = input.env ?? {}
  const call = <T>(fn: unknown, args: Record<string, unknown>) =>
    withConvexRetry({
      idempotent: true,
      attempt: () => withTimeout(
        new ConvexHttpClient(input.url).mutation(fn as never, {
          service_token: input.serviceToken,
          ...(input.leaseMs === undefined ? {} : { lease_ms: input.leaseMs }),
          ...args,
        } as never),
        controlPlaneTimeoutMs("mutation", env),
      ),
    }) as Promise<T>

  return {
    acquire: ({ name, holder }) =>
      call(cronLeaseApi.cronLease.acquire, { name, holder, now: now() }),
    release: ({ name, holder, fence }) =>
      call(cronLeaseApi.cronLease.release, { name, holder, fence, now: now() }),
  }
}
