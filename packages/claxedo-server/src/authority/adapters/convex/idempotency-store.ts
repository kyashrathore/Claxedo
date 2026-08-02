/**
 * W4.2/W4.3 — the Convex adapter behind `DurableIdempotencyStore`.
 *
 * Same calling convention as the rest of this directory: service-token mutations
 * over `ConvexHttpClient`, each wrapped in `withTimeout`. `now` is passed from
 * the caller rather than read inside the mutation because Convex mutations are
 * deterministic-replay-sensitive about clock reads, which is the convention
 * `convex/orgs.ts` and `convex/sandboxLeases.ts` already follow (`args.now`).
 *
 * These three mutations all carry an idempotency-shaped argument
 * (`cache_key` + `fingerprint`) and are safe to replay, so they inherit the
 * W4.1 executor retry when routed through `requireExecutor`. Here they are
 * called directly with a service token, so the retry is applied explicitly.
 */

import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import type { DurableIdempotencyStore } from "../../http/idempotency"
import { controlPlaneTimeoutMs, withTimeout } from "./timeout"
import { withConvexRetry } from "./retry"

type IdempotencyApi = {
  idempotency: {
    begin: FunctionReference<"mutation">
    complete: FunctionReference<"mutation">
    release: FunctionReference<"mutation">
  }
}

const idempotencyApi = anyApi as unknown as IdempotencyApi

export type ConvexIdempotencyStoreInput = {
  url: string
  serviceToken: string
  env?: Record<string, string | undefined>
  now?: () => number
}

export function createConvexIdempotencyStore(input: ConvexIdempotencyStoreInput): DurableIdempotencyStore {
  const now = input.now ?? (() => Date.now())
  const env = input.env ?? {}
  const call = <T>(fn: unknown, args: Record<string, unknown>) =>
    withConvexRetry({
      idempotent: true,
      attempt: () => withTimeout(
        new ConvexHttpClient(input.url).mutation(fn as never, {
          service_token: input.serviceToken,
          ...args,
        } as never),
        controlPlaneTimeoutMs("mutation", env),
      ),
    }) as Promise<T>

  return {
    begin: ({ cacheKey, fingerprint }) =>
      call(idempotencyApi.idempotency.begin, { cache_key: cacheKey, fingerprint, now: now() }),
    complete: ({ cacheKey, fingerprint, resultJson }) =>
      call(idempotencyApi.idempotency.complete, {
        cache_key: cacheKey,
        fingerprint,
        ...(resultJson === undefined ? {} : { result_json: resultJson }),
        now: now(),
      }),
    release: ({ cacheKey, fingerprint }) =>
      call(idempotencyApi.idempotency.release, { cache_key: cacheKey, fingerprint }),
  }
}
