import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { z } from "zod"
import {
  ControlPlaneAuthError,
  controlPlaneAuthErrorBody,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { isClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { asRecord } from "@claxedo/server-core/platform/json/index"
import type { ControlPlaneServices } from "../../authority/services"
import type { ConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { contentfulStatus } from "../../platform/http/status"
import { controlPlaneRateLimitError } from "../../workspace/runtime-token-guards"
import { parsedBody, signedOrError, type WorkspaceRouteOptions } from "../../workspace/route-support"

export type AccountRouteBudget = { limiter: ConnectionRateLimiter; key: string; action: string }

export function missingBearer() {
  return { error: { code: "unauthorized", message: "Missing bearer token" } }
}

/** `{ error: { code, message, ...details } }` for any thrown `ClaxedoError`; everything else stays a 500. */
export function claxedoErrorResponse(c: Context, err: unknown) {
  if (err instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(err), err.status)
  if (!isClaxedoError(err)) return undefined
  const details = asRecord(asRecord(err)?.details) ?? {}
  return c.json({ error: { code: err.code, message: err.message, ...details } }, contentfulStatus(err.status))
}

export function tooLarge(limit: number) {
  return bodyLimit({
    maxSize: limit,
    onError: (c) =>
      c.json({ error: { code: "request_body_too_large", message: `Request body exceeds the ${limit}-byte limit` } }, 413),
  })
}

/**
 * The body as JSON, read through the route's `bodyLimit` so an oversized body
 * is the middleware's 413 rather than a schema 400; unparseable text is an
 * empty object the schema then refuses.
 */
export async function requestJsonThroughLimit(c: Context): Promise<unknown> {
  return parseJsonText(await c.req.text())
}

export function parseJsonText(text: string): unknown {
  try {
    return text === "" ? {} : JSON.parse(text)
  } catch {
    return {}
  }
}

export function unsupported(c: Context, what: string) {
  return c.json({ error: { code: "machine_caller_unsupported", message: `${what} is not supported by this authority` } }, 501)
}

export function unsupportedError(what: string) {
  return new ControlPlaneAuthError(503, "workspace_authority_unavailable", `${what} is not supported by this authority`)
}

/**
 * Authenticate the account caller, resolve the authority, run the handler,
 * map the failures.
 *
 * One wrapper rather than the same fifteen lines in each handler: the
 * interesting part of each route is two lines, and repeating the auth dance
 * around them is how one of them ends up missing a check. Generic over the
 * SCHEMA rather than over a caller-supplied body type: the body a route sees
 * is `z.infer` of the schema it was given, so the two cannot disagree.
 */
export function signedAccountHandler(services: ControlPlaneServices, options: WorkspaceRouteOptions) {
  return <Schema extends z.ZodTypeAny>(
    schema: Schema,
    run: (input: {
      body: z.infer<Schema>
      auth: SignedControlPlaneAuth
      authority: WorkspaceAuthority
      c: Context
    }) => Promise<Record<string, unknown>>,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    budget: AccountRouteBudget,
  ) =>
    async (c: Context) => {
      // Signed only. There is no unsigned path to a machine's enrollment: a
      // loopback caller with no account has no account to enroll a machine
      // against.
      const authResult = await signedOrError(c.req.raw, { ...options, requireSigned: true as const }, services)
      if ("error" in authResult) return c.json(authResult.error, authResult.status)
      const auth = authResult.auth
      // Type narrowing, not a second check: `requireSigned: true` above means
      // an unsigned request already returned 401 from `signedOrError`.
      if (!auth) return c.json(missingBearer(), 401)

      // Keyed on the verified account (`controlPlaneRateLimitError` reads
      // `auth.user.subject`), so it is spent BEFORE the body is read and long
      // before any authority round-trip or signature verification — a flood
      // must be rejected while rejecting it is still cheap.
      const limited = await controlPlaneRateLimitError(services, budget.limiter, auth, {
        key: budget.key,
        action: budget.action,
      })
      if (limited) return c.json(limited.body, limited.status)

      const parsed = method === "GET" || method === "DELETE"
        ? parsedBody(schema, {})
        : parsedBody(schema, await requestJsonThroughLimit(c))
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)

      try {
        return c.json(await run({ body: parsed.body, auth, authority: requireAuthority(services), c }))
      } catch (err) {
        return claxedoErrorResponse(c, err) ?? Promise.reject(err)
      }
    }
}
