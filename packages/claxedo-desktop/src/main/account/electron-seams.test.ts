import { describe, expect, test } from "bun:test"
import { controlPlaneBearerFromTokenPayload, isJwtShaped } from "./electron-seams"

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
