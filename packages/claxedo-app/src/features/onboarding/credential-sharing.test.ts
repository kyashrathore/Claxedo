import { describe, expect, test } from "bun:test"
import { cloudShareBlock, isCloudRelevantCredential, isCloudShareable } from "./credential-sharing"
import type { OnboardingCredential } from "./state"

function credential(overrides: Partial<OnboardingCredential> = {}): OnboardingCredential {
  return {
    id: "cred-1",
    providerId: "anthropic",
    scope: "local",
    machineId: "machine-a",
    verification: "ok",
    ...overrides,
  } as OnboardingCredential
}

describe("cloud shareability", () => {
  test("a discovered Claude Code login is never shareable, under either provider binding", () => {
    // `claudeOAuthItem` is the only producer of these rows and always writes
    // `kind: "oauth_token"` — this is the machine's Keychain login. The two
    // bindings it can land under are `claude-sdk` (the harness id) and the
    // bare `anthropic` provider id.
    for (const providerId of ["claude-sdk", "anthropic"]) {
      const login = credential({ providerId, kind: "oauth_token", label: "Claude Code login" })
      expect(isCloudShareable(login)).toBe(false)
      expect(cloudShareBlock(login)?.repair).toContain("claude setup-token")
    }
  })

  test("the block explains that Claude Code owns the token and sharing can sign the user out", () => {
    const block = cloudShareBlock(credential({ providerId: "claude-sdk", kind: "oauth_token" }))
    expect(block?.reason).toContain("Claude Code owns this login")
    expect(block?.reason).toContain("sign you out")
  })

  test("a `claude setup-token` value shares — it is minted for exactly this", () => {
    // CONTRACT, pinned from this side: a Claude-harness credential with kind
    // "api_key" IS shareable. A pasted `sk-ant-oat01-…` setup-token is stored
    // as api_key because kind records how the secret was ENTERED, not what it
    // is. Reclassifying it to oauth_token server-side would silently block the
    // only cloud path Claude has — this test is what fails loudly instead.
    for (const providerId of ["claude-sdk", "anthropic"]) {
      const token = credential({ providerId, kind: "api_key", label: "Claude setup token" })
      expect(isCloudShareable(token)).toBe(true)
      expect(cloudShareBlock(token)).toBeUndefined()
    }
  })

  test("Codex OAuth shares — the server rewrites ~/.codex after every refresh", () => {
    for (const providerId of ["codex-app-server", "openai"]) {
      expect(isCloudShareable(credential({ providerId, kind: "oauth_token" }))).toBe(true)
    }
  })

  test("a Cursor dashboard key shares — no rotation and no other owner", () => {
    expect(isCloudShareable(credential({ providerId: "cursor-sdk", kind: "api_key" }))).toBe(true)
  })

  test("plain API keys share, whatever the provider", () => {
    for (const providerId of ["anthropic", "openai", "openrouter", "google"]) {
      expect(isCloudShareable(credential({ providerId, kind: "api_key" }))).toBe(true)
    }
  })

  test("a sandbox driver token is not part of this question at all", () => {
    // It provisions every sandbox; putting it inside one would hand an agent
    // control of the whole fleet. Excluded from the step, not explained in it.
    const driver = credential({ providerId: "daytona", kind: "sandbox_driver" })
    expect(isCloudRelevantCredential(driver)).toBe(false)
    expect(isCloudShareable(driver)).toBe(false)
    expect(cloudShareBlock(driver)).toBeUndefined()
  })

  test("namespaced connection and channel credentials are not model auth", () => {
    for (const providerId of ["integration:notion", "channel:telegram"]) {
      expect(isCloudRelevantCredential(credential({ providerId, kind: "api_key" }))).toBe(false)
      expect(isCloudShareable(credential({ providerId, kind: "api_key" }))).toBe(false)
    }
  })

  test("a kindless Claude harness row from an older server is treated as the login", () => {
    // Discovery is the only thing that writes `claude-sdk` rows without an
    // explicit kind, so the ambiguity resolves closed: guessing wrong here
    // costs the user their own Claude Code session. (A kindless `anthropic`
    // row resolves the other way — see the test below — because that id is
    // also the bare API-key provider.)
    expect(isCloudShareable(credential({ providerId: "claude-sdk" }))).toBe(false)
  })

  test("a kindless bare-provider row still shares — `anthropic` is the API-key row", () => {
    expect(isCloudShareable(credential({ providerId: "anthropic" }))).toBe(true)
    expect(isCloudShareable(credential({ providerId: "openai" }))).toBe(true)
  })

  test("`source` never decides shareability, because the save path derives it from scope", () => {
    // discovery.ts writes source from the CHOSEN SCOPE, so the same discovered
    // login reports "managed" or "local_only" depending on nothing meaningful.
    for (const source of ["managed", "local_only", "env", "upstream_sync"] as const) {
      expect(isCloudShareable(credential({ providerId: "claude-sdk", kind: "oauth_token", source }))).toBe(false)
      expect(isCloudShareable(credential({ providerId: "codex-app-server", kind: "oauth_token", source }))).toBe(true)
    }
  })
})
