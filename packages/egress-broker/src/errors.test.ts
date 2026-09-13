import { expect, test } from "vitest"
import { BROKER_ERRORS, brokerErrorBody, type BrokerErrorCode } from "./errors.js"

/**
 * `@opencode-ai/ai@0.0.0-beta-18684` reads a failed provider response through
 * `providerMessage`, which decodes `{ message?, error?: { message? } }` and
 * shows `error.message`. A body whose `error` is a bare string fails that decode
 * outright, and the operator is shown "Provider request failed with HTTP 403"
 * for the one failure they can act on.
 */
const decodesLikeProviderMessage = (body: unknown) => {
  const row = body as { message?: unknown; error?: { message?: unknown } }
  if (row.message !== undefined && typeof row.message !== "string") return undefined
  if (typeof row.error !== "object" || row.error === null) return undefined
  const message = row.error.message
  return typeof message === "string" && message.trim() ? message : undefined
}

test("every refusal names a code and carries a message the engine will show", () => {
  for (const code of Object.keys(BROKER_ERRORS) as BrokerErrorCode[]) {
    const body = brokerErrorBody(code)
    expect(body.error.code).toBe(code)
    expect(decodesLikeProviderMessage(body)).toBe(BROKER_ERRORS[code])
  }
})

test("the shape the broker used to answer with is discarded by that same reader", () => {
  expect(decodesLikeProviderMessage({ error: "binding_unavailable" })).toBeUndefined()
})
