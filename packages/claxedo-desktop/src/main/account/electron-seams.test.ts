import { describe, expect, test } from "bun:test"
import { controlPlaneBearerFromTokenPayload, isJwtShaped, tokenExchange } from "./electron-seams"

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.sig"

describe("isJwtShaped", () => {
  test("accepts compact JWTs", () => {
    expect(isJwtShaped(JWT)).toBe(true)
  })

  test("rejects opaque OAuth access tokens", () => {
    expect(isJwtShaped("oat_opaque_not_a_jwt")).toBe(false)
    expect(isJwtShaped("")).toBe(false)
    expect(isJwtShaped("only.two")).toBe(false)
  })
})

describe("controlPlaneBearerFromTokenPayload", () => {
  test("prefers a JWT access token", () => {
    expect(controlPlaneBearerFromTokenPayload({
      access_token: JWT,
      id_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJpZCJ9.id",
    })).toBe(JWT)
  })

  test("falls back to id_token when access_token is opaque", () => {
    const id = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJpZCJ9.id"
    expect(controlPlaneBearerFromTokenPayload({
      access_token: "oat_opaque",
      id_token: id,
    })).toBe(id)
  })

  test("keeps opaque access_token when no id_token exists", () => {
    expect(controlPlaneBearerFromTokenPayload({ access_token: "oat_opaque" })).toBe("oat_opaque")
  })
})

describe("tokenExchange", () => {
  const EXCHANGE_INPUT = {
    tokenUrl: "https://core.example/api/auth/oauth2/token",
    clientId: "desktop_1",
    code: "code_1",
    codeVerifier: "verifier_1",
    redirectUri: "http://127.0.0.1:49152/oauth/callback",
    resource: "https://core.example/api/claxedo",
  }

  test("rejects a token response without a finite positive lifetime", async () => {
    const exchange = tokenExchange(async () => Response.json({
      access_token: JWT,
      refresh_token: "rt_1",
    }))

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow("valid access token and lifetime")
  })

  test("retries once on a fresh connection when the first attempt stalls without headers", async () => {
    const attempts: Array<{ aborted: boolean }> = []
    const exchange = tokenExchange((_url, init) => {
      const attempt = { aborted: false }
      attempts.push(attempt)
      if (attempts.length === 1) {
        // A stalled edge: headers never arrive. Resolution only through abort.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            attempt.aborted = true
            reject(new Error("socket destroyed"))
          })
        })
      }
      return Promise.resolve(Response.json({ access_token: JWT, refresh_token: "rt_1", expires_in: 300 }))
    }, 240)

    const tokens = await exchange(EXCHANGE_INPUT)
    expect(tokens.accessToken).toBe(JWT)
    expect(attempts.length).toBe(2)
    // The stalled socket must be destroyed before the retry, so the first
    // attempt's grant can never be processed later.
    expect(attempts[0]!.aborted).toBe(true)
  })

  test("fails inside the overall budget when the retry stalls too", async () => {
    let attempts = 0
    const exchange = tokenExchange((_url, init) => {
      attempts += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("socket destroyed")))
      })
    }, 120)

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow("timed out")
    expect(attempts).toBe(2)
  })

  test("propagates parent cancellation without a retry", async () => {
    let attempts = 0
    const controller = new AbortController()
    const exchange = tokenExchange(() => {
      attempts += 1
      queueMicrotask(() => controller.abort(new Error("sign-in cancelled")))
      return new Promise<Response>(() => {})
    }, 5_000)

    await expect(exchange({ ...EXCHANGE_INPUT, signal: controller.signal })).rejects.toThrow("sign-in cancelled")
    expect(attempts).toBe(1)
  })
})
