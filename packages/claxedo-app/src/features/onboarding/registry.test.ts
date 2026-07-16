import { describe, expect, test } from "bun:test"
import { onboardingStepStates } from "./registry"
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

function states(input: Partial<OnboardingStateInput> = {}) {
  return onboardingStepStates(onboardingState({ ...base, ...input }))
}

function step(id: "project" | "ai" | "compute" | "remote-access", input: Partial<OnboardingStateInput> = {}) {
  return states(input).find((item) => item.id === id)!
}

const verified = {
  id: "cred-1",
  providerId: "anthropic",
  scope: "shared" as const,
  verification: "ok" as const,
}

describe("onboarding step registry", () => {
  test("shows the four desktop steps with compute and remote access locked before the first turn", () => {
    const steps = onboardingStepStates(onboardingState(base))

    expect(steps.map((step) => step.id)).toEqual(["project", "ai", "compute", "remote-access"])
    expect(steps.map((step) => ({ applies: step.applies, done: step.done, locked: step.locked }))).toEqual([
      { applies: true, done: false, locked: false },
      { applies: true, done: false, locked: false },
      { applies: true, done: false, locked: true },
      { applies: true, done: false, locked: true },
    ])
    expect(steps[2].lockReason).toBe("Complete your first task to unlock cloud compute.")
    expect(steps[3].lockReason).toBe("Complete your first task to unlock remote access.")
  })

  test("unlocks desktop compute and remote access together after the first turn", () => {
    expect(step("compute").locked).toBe(true)
    expect(step("remote-access").locked).toBe(true)

    expect(step("compute", { hasFirstTurn: true }).locked).toBe(false)
    expect(step("remote-access", { hasFirstTurn: true }).locked).toBe(false)
  })

  test("keeps remote access honestly locked while external gates are unavailable", () => {
    expect(step("remote-access", {
      hasFirstTurn: true,
      remoteAccessAvailable: false,
      remoteAccessLockedReason: "Device sign-in and the hosted relay are not available yet.",
    })).toMatchObject({
      locked: true,
      lockReason: "Device sign-in and the hosted relay are not available yet.",
    })
  })

  test.each(["web", "self-host"] as const)("enforces the ordered %s setup transitions", (surface) => {
    expect(step("project", { surface }).locked).toBe(false)
    expect(step("ai", { surface }).locked).toBe(true)
    expect(step("ai", { surface, hasProject: true }).locked).toBe(false)
    expect(step("compute", { surface, hasProject: true }).locked).toBe(true)
    expect(step("compute", { surface, hasProject: true, credentials: [verified] }).locked).toBe(false)
    expect(step("remote-access", { surface, credentials: [verified] }).locked).toBe(true)
    expect(step("remote-access", { surface, credentials: [verified], hasFirstCloudTurn: true }).locked).toBe(false)
  })

  test.each(["desktop", "web", "self-host"] as const)("derives proven done states on %s", (surface) => {
    const result = states({
      surface,
      hasProject: true,
      credentials: [verified],
      hasFirstTurn: true,
      hasFirstCloudTurn: true,
      secondDeviceOpen: true,
    })

    expect(result.every((item) => item.applies)).toBe(true)
    expect(result.map((item) => item.done)).toEqual([true, true, true, true])
    expect(result.map((item) => item.locked)).toEqual([false, false, false, false])
  })

  test("keeps a credential on another machine honest and actionable", () => {
    const ai = step("ai", {
      machineId: "machine-b",
      credentials: [{ ...verified, scope: "local", machineId: "machine-a" }],
    })

    expect(ai.done).toBe(false)
    expect(ai.cta).toEqual({ label: "Connect on this machine", action: "connect-ai" })
  })

  test("a Settings-driven credential update flips the AI step without onboarding-specific state", () => {
    let credentials: OnboardingStateInput["credentials"] = []
    const select = () => step("ai", { credentials })

    expect(select().done).toBe(false)
    credentials = [verified]
    expect(select().done).toBe(true)
  })

  test("resolves surface-aware actions and retains verification metadata", () => {
    expect(step("project").title).toBe("Open a project")
    expect(step("project", { surface: "web" }).title).toBe("Pick a repository")
    expect(step("project").cta).toEqual({ label: "Open a project", action: "open-project" })
    expect(step("project", { surface: "web" }).cta).toEqual({ label: "Pick a repository", action: "pick-repository" })
    expect(step("compute", { hasFirstTurn: true }).cta).toEqual({ label: "Sign in to add compute", action: "sign-in" })
    expect(step("compute", { hasFirstTurn: true, hostedSignedIn: true }).cta).toEqual({ label: "Add compute", action: "add-compute" })
    expect(step("remote-access", { hasFirstTurn: true }).cta).toEqual({ label: "Enable remote access", action: "enable-remote-access" })
    expect(step("remote-access", { hasFirstTurn: true, remoteAccessEnabled: true }).cta).toEqual({ label: "Open phone access", action: "open-phone-access" })
    expect(states().map((item) => item.verify)).toEqual(["repository", "credential", "cloud-turn", "second-device"])
  })
})
