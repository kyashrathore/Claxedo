import { describe, expect, test } from "bun:test"
import {
  liveProviderBinding,
  projectionRenewalDueAt,
  providerProjection,
  providerProjectionRecord,
} from "./provider-projection"

const minted = {
  baseUrl: "http://127.0.0.1:2595/bindings/61b4",
  placeholder: "signed-placeholder",
  authMode: "api-key" as const,
  expiresAt: 1_800_000_000_000,
}

const native = {
  baseUrl: "https://api.anthropic.com",
  placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
  authMode: "bearer" as const,
  apiPath: "/v1",
}

describe("provider projection", () => {
  test("a minted placeholder is carried through untouched", () => {
    expect(providerProjection(minted)).toEqual(minted)
  })

  test("a provider-issued placeholder is read off the environment the sandbox holds", () => {
    expect(providerProjection(native, { CLAXEDO_PROVIDER_CLAUDE_SDK: "dtn_secret_abc" })).toEqual({
      baseUrl: "https://api.anthropic.com",
      placeholder: "dtn_secret_abc",
      authMode: "bearer",
      apiPath: "/v1",
    })
  })

  test("a variable the sandbox provider never filled is unavailable, not absent", () => {
    // Absent would let the harness run on the login its image carries, which is
    // the identity the operator did not choose.
    expect(providerProjection(native, {})).toEqual({
      unavailable: true,
      reason: "placeholder_env_missing: CLAXEDO_PROVIDER_CLAUDE_SDK",
    })
    expect(providerProjection(native, { CLAXEDO_PROVIDER_CLAUDE_SDK: "" })).toEqual({
      unavailable: true,
      reason: "placeholder_env_missing: CLAXEDO_PROVIDER_CLAUDE_SDK",
    })
  })

  test("naming both a placeholder and a variable, or neither, is not a projection", () => {
    expect(providerProjection({ ...native, placeholder: "also-this" }, { CLAXEDO_PROVIDER_CLAUDE_SDK: "x" }))
      .toBeUndefined()
    expect(providerProjection({ baseUrl: "https://api.anthropic.com", authMode: "bearer" })).toBeUndefined()
  })

  test("a binding without an expiry is valid and never due for renewal", () => {
    const resolved = providerProjection(native, { CLAXEDO_PROVIDER_CLAUDE_SDK: "dtn_secret_abc" })!
    expect(liveProviderBinding("claude", resolved, () => 2_000_000_000_000)).toMatchObject({
      placeholder: "dtn_secret_abc",
    })
    expect(projectionRenewalDueAt({ "claude-sdk": resolved }, 1_000)).toBeUndefined()
  })

  test("a record resolves every row against the same environment", () => {
    expect(providerProjectionRecord(
      { "claude-sdk": native, openrouter: minted },
      { CLAXEDO_PROVIDER_CLAUDE_SDK: "dtn_secret_abc" },
    )).toEqual({
      "claude-sdk": { baseUrl: "https://api.anthropic.com", placeholder: "dtn_secret_abc", authMode: "bearer", apiPath: "/v1" },
      openrouter: minted,
    })
  })

  test("an expiry that is not a positive whole number of milliseconds is rejected", () => {
    expect(providerProjection({ ...minted, expiresAt: 0 })).toBeUndefined()
    expect(providerProjection({ ...minted, expiresAt: 1.5 })).toBeUndefined()
  })
})
