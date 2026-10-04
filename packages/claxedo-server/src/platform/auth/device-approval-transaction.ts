import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api"

type DeviceRequestRow = { id: string; userCode: string; userId?: string | null }

type DeviceRequestReader = {
  findOne: <T>(input: { model: string; where: { field: string; value: string }[] }) => Promise<T | null>
}

/**
 * Better Auth resolves a user code a human retyped with separators against the
 * stored separator-free row, so the same device request answers to more than
 * one spelling; the transaction must cover the row, not the spelling that
 * reached this endpoint.
 */
async function findDeviceRequest(adapter: DeviceRequestReader, userCode: string): Promise<DeviceRequestRow | null> {
  const find = (value: string) =>
    adapter.findOne<DeviceRequestRow>({ model: "deviceCode", where: [{ field: "userCode", value }] })
  const exact = await find(userCode)
  if (exact) return exact
  const normalized = userCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
  return normalized === userCode ? null : find(normalized)
}

async function transactionFor(secret: string, requestId: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`device-approval:${requestId}:${userId}`))
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function equalTransactions(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Binds a device approval to the pending request the approver was actually
 * shown.
 *
 * Better Auth authorizes `/device/approve` and `/device/deny` on the user code
 * plus whichever signed-in user claimed it, and `GET /device` claims an
 * unclaimed code for whoever loads it. A user code is short, displayed and
 * typed by hand, so those two facts alone let a request the approver never saw
 * ride their session.
 *
 * The transaction is derived rather than stored: an HMAC over the device
 * request row and the user it is claimed for, under the issuer's signing
 * secret. It is unguessable without the secret, it names exactly one request,
 * and it needs no column in either deployment's schema. `GET /device` returns
 * it only to the user the request is claimed for; a decision that presents
 * anything else — nothing, a guess, or the transaction of another request — is
 * refused before the endpoint runs.
 *
 * Deciding the request is still the claimant's alone: `/device/approve` owns
 * that check, and it is the only one of the two that can read the session,
 * because a before hook runs ahead of the header rewriting that lets a bearer
 * credential stand in for the session cookie.
 */
export function deviceApprovalTransaction(): BetterAuthPlugin {
  return {
    id: "claxedo-device-approval-transaction",
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === "/device/approve" || ctx.path === "/device/deny",
        handler: createAuthMiddleware(async (ctx) => {
          const userCode = ctx.body?.userCode
          if (typeof userCode !== "string") return
          const request = await findDeviceRequest(ctx.context.adapter, userCode)
          if (!request?.userId) return
          const presented = ctx.body?.transaction
          const expected = await transactionFor(ctx.context.secret, request.id, request.userId)
          if (typeof presented === "string" && equalTransactions(presented, expected)) return
          throw new APIError("FORBIDDEN", {
            error: "access_denied",
            error_description: "This decision does not carry the transaction of the device request it names",
          })
        }),
      }],
      after: [{
        matcher: (ctx) => ctx.path === "/device",
        handler: createAuthMiddleware(async (ctx) => {
          const viewed: unknown = ctx.context.returned
          if (isAPIError(viewed) || typeof viewed !== "object" || viewed === null) return undefined
          const userCode = (viewed as { user_code?: unknown }).user_code
          if (typeof userCode !== "string") return undefined
          const session = await getSessionFromCtx(ctx)
          if (!session) return undefined
          const request = await findDeviceRequest(ctx.context.adapter, userCode)
          if (!request || request.userId !== session.user.id) return undefined
          return ctx.json({
            ...viewed,
            transaction: await transactionFor(ctx.context.secret, request.id, session.user.id),
          })
        }),
      }],
    },
  }
}
