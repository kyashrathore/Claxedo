import type { Context } from "hono"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { MachinePrincipal } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { verifyMachineRequest } from "@claxedo/server-core/platform/auth/machine-auth"
import type { ControlPlaneServices } from "../authority/services"
import type { ConnectionRateLimiter } from "../platform/auth/rate-limit"
import { requestClientKey } from "../platform/auth/request-guard"

export type MachineCallerBudgets = {
  /** Spent per client address before any body is parsed or any row is read. */
  clientRateLimiter: ConnectionRateLimiter
  /** Spent per enrollment only AFTER the verifier admitted the caller. */
  machineRateLimiter: ConnectionRateLimiter
  now: () => number
}

export function budgetExceeded(c: Context, retryAfterMs: number) {
  return c.json(
    { error: { code: "control_plane_rate_limited", message: "Control Plane request limit exceeded", retryAfterMs } },
    429,
  )
}

export function clientBudget(c: Context, limiter: ConnectionRateLimiter, key: string) {
  const result = limiter.check({ userId: requestClientKey(c), workspaceId: key })
  return result.allowed ? undefined : budgetExceeded(c, result.retryAfterMs)
}

/**
 * The machine caller's admission, in the P1.1 order: body cap (route
 * middleware, applied before this runs) → client-address budget → the
 * verifier over the exact body text → per-enrollment budget. A `Response` is
 * the refusal to answer with; otherwise the verified machine and the body
 * text the signature covered, which the route reads once and parses itself.
 */
export async function admitMachineCaller(
  c: Context,
  services: ControlPlaneServices,
  budgets: MachineCallerBudgets,
  key: string,
): Promise<{ machine: MachinePrincipal; bodyText: string } | Response> {
  const limited = clientBudget(c, budgets.clientRateLimiter, `client:${key}`)
  if (limited) return limited
  const authority = requireAuthority(services)
  if (!authority.machineAuth) {
    return c.json({ error: { code: "machine_caller_unsupported", message: "Machine-signed enrollment is not supported by this authority" } }, 501)
  }
  const bodyText = await c.req.text()
  const verified = await verifyMachineRequest(
    { method: c.req.method, url: c.req.url, headers: c.req.raw.headers, bodyText },
    { ...authority.machineAuth, now: budgets.now },
  )
  if (!verified.ok) {
    return c.json({ error: { code: verified.code, message: "Machine request refused" } }, verified.status)
  }
  const perEnrollment = budgets.machineRateLimiter.check({
    userId: `machine:${verified.machine.enrollmentId}`,
    workspaceId: key,
  })
  if (!perEnrollment.allowed) return budgetExceeded(c, perEnrollment.retryAfterMs)
  return { machine: verified.machine, bodyText }
}
