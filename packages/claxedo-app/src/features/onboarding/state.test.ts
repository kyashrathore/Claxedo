import { describe, expect, test } from "bun:test"
import { onboardingState, type OnboardingStateInput } from "./state"

const base = {
  surface: "desktop",
  machineId: "machine-a",
  credentials: [],
  runnableHarnesses: [],
  hasProject: false,
  sandboxProviderConfigured: false,
  hasFirstTurn: false,
  hasFirstCloudTurn: false,
  hostedSignedIn: false,
  remoteAccessEnabled: false,
  secondDeviceOpen: false,
} satisfies OnboardingStateInput

describe("onboardingState", () => {
  test("derives a verified local credential as usable on its machine without mutating source state", () => {
    const writes: string[] = []
    const credentials = Object.freeze([
      Object.freeze({
        id: "cred-1",
        providerId: "anthropic",
        scope: "local" as const,
        machineId: "machine-a",
        verification: "ok" as const,
      }),
    ])
    const input = new Proxy({ ...base, credentials }, {
      set(_target, property) {
        writes.push(String(property))
        return false
      },
    })

    expect(onboardingState(input)).toMatchObject({
      hasUsableCredential: true,
      hasCredentialElsewhere: false,
      credentialAvailability: "available",
    })
    expect(writes).toEqual([])
    expect(input.credentials).toBe(credentials)
  })

  test("re-derives from a Settings credential change with no onboarding mutation", () => {
    let credentials: OnboardingStateInput["credentials"] = []
    const select = () => onboardingState({ ...base, credentials })

    expect(select().credentialAvailability).toBe("none")

    credentials = [{
      id: "cred-1",
      providerId: "anthropic",
      scope: "local",
      machineId: "machine-a",
      verification: "ok",
    }]

    expect(select().credentialAvailability).toBe("available")
  })

  test("keeps local credentials machine-bound while shared credentials work everywhere", () => {
    const local = {
      id: "cred-local",
      providerId: "anthropic",
      scope: "local" as const,
      machineId: "machine-a",
      verification: "ok" as const,
    }

    expect(onboardingState({ ...base, machineId: "machine-a", credentials: [local] })).toMatchObject({
      hasUsableCredential: true,
      hasCredentialElsewhere: false,
      credentialAvailability: "available",
    })
    expect(onboardingState({ ...base, machineId: "machine-b", credentials: [local] })).toMatchObject({
      hasUsableCredential: false,
      hasCredentialElsewhere: true,
      credentialAvailability: "other-machine",
    })
    expect(onboardingState({
      ...base,
      machineId: "machine-b",
      credentials: [{ ...local, id: "cred-shared", scope: "shared" }],
    })).toMatchObject({
      hasUsableCredential: true,
      hasCredentialElsewhere: false,
      credentialAvailability: "available",
    })
  })

  test("does not count an unproven or failed credential as usable", () => {
    const states = (["unverified", "auth_failed", "no_billing", "expired"] as const).map((verification) =>
      onboardingState({
        ...base,
        credentials: [{ id: verification, providerId: "anthropic", scope: "shared", verification }],
      }).credentialAvailability
    )

    expect(states).toEqual(["none", "none", "none", "none"])
  })

  test("counts a rate-capped subscription as usable", () => {
    // The provider answered — the account is authenticated and simply at its
    // quota. Treating it as unusable meant a valid subscription could never
    // finish onboarding until its window reset.
    const state = onboardingState({
      ...base,
      credentials: [{ id: "capped", providerId: "anthropic", scope: "shared", verification: "rate_capped" }],
    })

    expect(state.credentialAvailability).toBe("available")
    expect(state.hasUsableCredential).toBe(true)
  })

  test("a directly probed local harness makes AI runnable without synthesizing a credential", () => {
    const state = onboardingState({
      ...base,
      destination: "local",
      runnableHarnesses: ["codex"],
    })

    expect(state.hasRunnableAI).toBe(true)
    expect(state.hasUsableCredential).toBe(false)
    expect(state.credentials).toEqual([])
  })

  test("a local harness cannot satisfy a cloud destination", () => {
    const state = onboardingState({
      ...base,
      destination: "both",
      runnableHarnesses: ["codex"],
    })

    expect(state.hasRunnableAI).toBe(false)
  })

  test("separates credentials the cloud can already reach from machine-local ones", () => {
    const state = onboardingState({
      ...base,
      credentials: [
        { id: "shared", providerId: "anthropic", scope: "shared", verification: "ok" },
        { id: "local", providerId: "openai", scope: "local", machineId: base.machineId, verification: "ok" },
        { id: "elsewhere", providerId: "openai", scope: "local", machineId: "machine-z", verification: "ok" },
      ],
    })

    expect(state.hasCloudReadyCredential).toBe(true)
    // Only this machine's local credential is ours to offer for sharing.
    expect(state.localOnlyCredentials.map((credential) => credential.id)).toEqual(["local"])
  })

  test("a discovered Claude Code login is separated out as unshareable, not offered", () => {
    const state = onboardingState({
      ...base,
      credentials: [
        { id: "claude", providerId: "claude-sdk", kind: "oauth_token", scope: "local", machineId: base.machineId, verification: "ok" },
        { id: "codex", providerId: "codex-app-server", kind: "oauth_token", scope: "local", machineId: base.machineId, verification: "ok" },
      ],
    })

    expect(state.localOnlyCredentials.map((credential) => credential.id)).toEqual(["codex"])
    expect(state.unshareableCredentials.map((credential) => credential.id)).toEqual(["claude"])
  })

  test("a sandbox driver token is neither offered nor explained — it was never model auth", () => {
    const state = onboardingState({
      ...base,
      credentials: [
        { id: "daytona", providerId: "daytona", kind: "sandbox_driver", scope: "local", machineId: base.machineId, verification: "ok" },
      ],
    })

    expect(state.localOnlyCredentials).toEqual([])
    expect(state.unshareableCredentials).toEqual([])
  })

  test("a machine holding only an unshareable Claude login has nothing to share", () => {
    const state = onboardingState({
      ...base,
      credentials: [
        { id: "claude", providerId: "claude-sdk", kind: "oauth_token", scope: "local", machineId: base.machineId, verification: "ok" },
      ],
    })

    expect(state.localOnlyCredentials).toEqual([])
    // Still a usable credential — it runs fine locally, it just cannot travel.
    expect(state.hasUsableCredential).toBe(true)
  })
})
