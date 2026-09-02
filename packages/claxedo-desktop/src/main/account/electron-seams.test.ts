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

  test("never retries: one attempt, bounded by a deadline, with a clear terminal error", async () => {
    let attempts = 0
    let aborted = false
    const exchange = tokenExchange((_url, init) => {
      attempts += 1
      // No response ever arrives; resolution only through the deadline abort.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("socket destroyed"))
        })
      })
    }, 30)

    await expect(exchange(EXCHANGE_INPUT)).rejects.toThrow()
    expect(attempts, "no second attempt on a fresh connection").toBe(1)
    expect(aborted, "the stalled attempt's socket must be destroyed").toBe(true)
  })

  test("propagates parent cancellation", async () => {
    let attempts = 0
    const controller = new AbortController()
    const exchange = tokenExchange((_url, init) => {
      attempts += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("sign-in cancelled")))
      })
    }, 5_000)

    const pending = exchange({ ...EXCHANGE_INPUT, signal: controller.signal })
    controller.abort(new Error("sign-in cancelled"))
    await expect(pending).rejects.toThrow("sign-in cancelled")
    expect(attempts).toBe(1)
  })
})
