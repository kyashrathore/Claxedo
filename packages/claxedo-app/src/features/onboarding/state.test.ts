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
    const states = (["unverified", "auth_failed", "no_billing", "rate_capped", "expired"] as const).map((verification) =>
      onboardingState({
        ...base,
        credentials: [{ id: verification, providerId: "anthropic", scope: "shared", verification }],
      }).credentialAvailability
    )

    expect(states).toEqual(["none", "none", "none", "none", "none"])
  })
})
