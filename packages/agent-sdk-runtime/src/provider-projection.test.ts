import { describe, expect, test } from "bun:test"
import {
  liveProviderBinding,
  projectionRenewalDueAt,
  providerBinding,
  ProviderCredentialUnavailableError,
  providerProjection,
  providerProjectionRecord,
  UNRESOLVED_PROJECTION_REASON,
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

  test("a record from another process refuses every row when one cannot be read", () => {
    expect(providerProjectionRecord({ openrouter: minted, anthropic: { ...minted, authMode: "basic" } }))
      .toBeUndefined()
  })

  test("a record projecting a process's own authority disables only the row it cannot read", () => {
    expect(providerProjectionRecord(
      { openrouter: minted, anthropic: { ...minted, authMode: "basic" } },
      {},
      { onInvalid: "unavailable" },
    )).toEqual({
      openrouter: minted,
      // Unavailable rather than absent: an absent row is what a harness reads
      // as "no account chosen", and it answers that by running the turn on
      // whatever login the machine holds.
      anthropic: { unavailable: true, reason: UNRESOLVED_PROJECTION_REASON },
    })
  })

  test("an expiry that is not a positive whole number of milliseconds is rejected", () => {
    expect(providerProjection({ ...minted, expiresAt: 0 })).toBeUndefined()
    expect(providerProjection({ ...minted, expiresAt: 1.5 })).toBeUndefined()
  })

  test("a field this runtime does not model is refused, never dropped", () => {
    // Dropping it would let a producer believe a field took effect, and the one
    // field worth sending by mistake is a secret.
    expect(providerProjection({ ...minted, secret: "sk-ant-api03-real" })).toBeUndefined()
    expect(providerProjection({ unavailable: true, reason: "auth_failed", secret: "x" })).toBeUndefined()
  })

  test("an api path that is not a path under the binding is refused", () => {
    expect(providerProjection({ ...minted, apiPath: "v1" })).toBeUndefined()
    expect(providerProjection({ ...minted, apiPath: 1 })).toBeUndefined()
    expect(providerProjection({ ...minted, apiPath: "/v1" })).toMatchObject({ apiPath: "/v1" })
    // The empty string is an authority saying this binding IS the API root.
    expect(providerProjection({ ...minted, apiPath: "" })).toMatchObject({ apiPath: "" })
  })

  test("an unavailable account stops the launch by name instead of reaching the implicit tier", () => {
    const refusal = () => providerBinding("cursor", { unavailable: true, reason: "auth_failed" })
    expect(refusal).toThrow(ProviderCredentialUnavailableError)
    // The turn-outcome classifier reads the message, so the word is load-bearing.
    expect(refusal).toThrow("the cursor credential selected for this workspace cannot be used: auth_failed")
    expect(providerBinding("cursor", undefined)).toBeUndefined()
  })

  test("renewal falls at half of the placeholder's own remaining lifetime", () => {
    const appliedAt = 1_000_000
    const expiresAt = appliedAt + 60 * 60 * 1000
    expect(projectionRenewalDueAt({ anthropic: { ...minted, expiresAt } }, appliedAt))
      .toBe(appliedAt + 30 * 60 * 1000)
    // The earliest in the map decides: a turn must never start on one already gone.
    expect(projectionRenewalDueAt({
      anthropic: { ...minted, expiresAt },
      openai: { ...minted, expiresAt: appliedAt + 10 * 60 * 1000 },
    }, appliedAt)).toBe(appliedAt + 5 * 60 * 1000)
    expect(projectionRenewalDueAt({ anthropic: { unavailable: true, reason: "auth_failed" } }, appliedAt))
      .toBeUndefined()
  })
})
