import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../../auth"
import { controlPlaneTimeoutMs, withTimeout } from "./timeout"
import { withConvexRetry, type ConvexRetryOptions } from "./retry"
import type { ConvexExecutor, OrgId, ProjectRole, ProjectRoleResult } from "./convex-authority-types"

const allowResult = z.object({
  allowed: z.literal(true),
})

export function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

export function requireExecutor(input?: {
  url?: string
  executor?: ConvexExecutor
}, auth?: SignedControlPlaneAuth, options: { allowUnsigned?: boolean } = {}) {
  if (input?.executor) return input.executor
  if (!auth && !options.allowUnsigned) {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  const url = input?.url ?? convexUrl()
  if (!url) {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Convex authority is not configured")
  }
  return executor(url, auth?.token)
}

export function requireServiceToken(input?: { serviceToken?: string }) {
  const token = clean(input?.serviceToken) ?? serviceToken()
  if (!token) {
    throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Control Plane service token is not configured")
  }
  return token
}

export async function requireAllowed(result: unknown) {
  if (allowResult.safeParse(result).success) return
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Convex denied workspace access")
}

export function projectResult(input: unknown): ProjectRoleResult {
  const result = input as { ok?: boolean; role?: ProjectRole; org_id?: string; orgId?: string }
  if (!result.ok || !result.role) return { ok: false }
  const orgId = result.orgId ?? result.org_id
  return orgId ? { ok: true, role: result.role, orgId: orgId as OrgId } : { ok: false }
}

function convexUrl(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
}

function serviceToken(env: NodeJS.ProcessEnv = process.env) {
  return clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
}

/**
 * W4.1 — the argument names that make a Convex mutation safe to replay.
 *
 * A mutation is retryable only if the SERVER can recognize the second delivery
 * as the same operation. That recognition always rides an argument the caller
 * supplies, so the presence of one of these names is the whole test:
 *
 *   - `operation_id` — the org-deletion cascade's lease/receipt key
 *     (`convex/orgs.ts` `prepareOrgDeletion`), which returns the recorded
 *     result for a replayed id instead of re-running the cascade.
 *   - `idempotency_key` — `@claxedo/wakes` rows and the wake receipt table
 *     (`convex/schema.ts` `by_tenant_idempotency`, `wake_receipts`).
 *   - `source_ts` — a monotonic watermark guard: a re-apply at an already-seen
 *     timestamp no-ops. Used by the billing mirror's state writer.
 *
 * Deliberately a NAME check rather than a per-function allowlist: a new
 * mutation that threads an operation id inherits the retry, and one that does
 * not gets none, with no list to remember to update. The failure mode is the
 * safe one — forgetting to add a name costs a retry, not a double write.
 */
const IDEMPOTENT_MUTATION_ARGS = ["operation_id", "operationId", "idempotency_key", "idempotencyKey", "source_ts"]

export function mutationIsReplaySafe(args: Record<string, unknown>) {
  return IDEMPOTENT_MUTATION_ARGS.some((name) => args[name] !== undefined)
}

function executor(url: string, token?: string, retryOptions?: ConvexRetryOptions): ConvexExecutor {
  // Keep clients per-ATTEMPT, not merely per-call.
  //
  // setAuth mutates client state, so a URL-keyed shared client could send one
  // principal's bearer token on another request — that is why the client was
  // already per-call. The per-ATTEMPT part is a W4.1 requirement on top:
  // `ConvexHttpClient.mutation` QUEUES on the client instance
  // (`convex/dist/.../http_client.js` `enqueueMutation`/`processMutationQueue`)
  // and drains it serially. Since `withTimeout` does not cancel the underlying
  // fetch, a timed-out mutation is still draining — so a retry issued on the
  // SAME client would sit in that queue behind the hung request and never reach
  // the network. It would double the caller's wait and buy nothing.
  //
  // A fresh client per attempt has its own empty queue, which is the only way a
  // retry after a timeout can actually be sent.
  const attemptClient = () => {
    const client = new ConvexHttpClient(url)
    if (token) client.setAuth(token)
    return client
  }
  const timedOut = () =>
    new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority request timed out")
  return {
    // Reads replay freely: a duplicate query has no side effect, so the only
    // cost of a retry is latency the caller is already waiting through.
    query: (fn, args) => withConvexRetry({
      idempotent: true,
      attempt: () => withTimeout(
        attemptClient().query(fn as never, args as never),
        controlPlaneTimeoutMs("read"),
        timedOut,
      ),
    }, retryOptions ?? {}),
    // Writes replay only when the args name a server-side idempotency key.
    // withTimeout does not cancel the fetch, so a timed-out mutation may still
    // land — retrying an unguarded one would apply it twice.
    mutation: (fn, args) => withConvexRetry({
      idempotent: mutationIsReplaySafe(args),
      attempt: () => withTimeout(
        attemptClient().mutation(fn as never, args as never),
        controlPlaneTimeoutMs("mutation"),
        timedOut,
      ),
    }, retryOptions ?? {}),
  }
}
