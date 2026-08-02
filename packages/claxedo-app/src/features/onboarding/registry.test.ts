import { describe, expect, test } from "bun:test"
import { onboardingSteps, onboardingStepStates, type OnboardingStepId } from "./registry"
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

function step(id: OnboardingStepId, input: Partial<OnboardingStateInput> = {}) {
  return states(input).find((item) => item.id === id)!
}

/** Everything the cloud answer needs before it can actually run a session. */
const cloudReady = {
  destination: "both",
  sandboxProviderConfigured: true,
  codeHostConnected: true,
} satisfies Partial<OnboardingStateInput>

const verified = {
  id: "cred-1",
  providerId: "anthropic",
  scope: "shared" as const,
  verification: "ok" as const,
}

describe("onboarding step registry", () => {
  test("is three steps: the cloud question, the AI, and remote access", () => {
    expect(onboardingSteps.map((item) => item.id)).toEqual(["destination", "ai", "remote-access"])
  })

  test("the AI step waits for the first answer, because that decides what it offers", () => {
    expect(step("ai")).toMatchObject({
      locked: true,
      lockReason: "Answer the first question to continue.",
    })
    expect(step("ai", { destination: "local" }).locked).toBe(false)
  })

  test("declining the cloud still owes a project — agents need somewhere to work", () => {
    // Which is why the picker lives in that branch rather than at its own step.
    expect(step("destination", { destination: "local" }).done).toBe(false)
    expect(step("destination", { destination: "local", hasProject: true }).done).toBe(true)
  })

  test("the cloud answer needs no local project — it clones instead", () => {
    expect(step("destination", { ...cloudReady, hasProject: false }).done).toBe(true)
  })

  test("both requirements met settles the step, whichever provider carries the key", () => {
    // Reported live: a machine where `daytona` was default-but-unconfigured and
    // `modal` was configured from ambient env showed both requirements green
    // and still would not advance, because the status only read the default.
    expect(step("destination", {
      destination: "both",
      sandboxProviderConfigured: true,
      codeHostConnected: true,
    }).done).toBe(true)
  })

  test("saying yes to the cloud is not the same as being ready for it", () => {
    // A bare yes would let setup promise a cloud session it cannot start.
    expect(step("destination", { destination: "both" }).done).toBe(false)
    expect(step("destination", { destination: "both", sandboxProviderConfigured: true }).done).toBe(false)
    expect(step("destination", { destination: "both", codeHostConnected: true }).done).toBe(false)
    expect(step("destination", cloudReady).done).toBe(true)
  })

  test("the first step is never locked — it is where the flow starts", () => {
    expect(step("destination").locked).toBe(false)
    expect(step("destination").done).toBe(false)
  })

  test("remote access is the one skippable step, and the only one needing an account", () => {
    expect(states().map((item) => [item.id, item.optional])).toEqual([
      ["destination", false],
      ["ai", false],
      ["remote-access", true],
    ])
  })

  test("remote access is done once it is enabled", () => {
    expect(step("remote-access").done).toBe(false)
    expect(step("remote-access", { remoteAccessEnabled: true }).done).toBe(true)
  })

  test("a server that cannot offer remote access says why rather than going quiet", () => {
    const locked = step("remote-access", {
      remoteAccessAvailable: false,
      remoteAccessLockedReason: "This build has no relay configured.",
    })

    expect(locked).toMatchObject({ locked: true, lockReason: "This build has no relay configured." })
  })

  test("an already-enabled remote access is not locked by a stale availability probe", () => {
    const enabled = step("remote-access", { remoteAccessAvailable: false, remoteAccessEnabled: true })
    expect(enabled.locked).toBe(false)
  })

  test.each(["web", "self-host"] as const)("%s has no machine to reach, so no remote-access step", (surface) => {
    expect(states({ surface }).filter((item) => item.applies).map((item) => item.id)).toEqual([
      "destination",
      "ai",
    ])
  })

  test("desktop gets all three", () => {
    expect(states().filter((item) => item.applies).map((item) => item.id)).toEqual([
      "destination",
      "ai",
      "remote-access",
    ])
  })

  test("derives proven done states once everything is satisfied", () => {
    const result = states({
      ...cloudReady,
      credentials: [verified],
      remoteAccessEnabled: true,
    })

    expect(result.every((item) => item.applies)).toBe(true)
    expect(result.map((item) => item.done)).toEqual([true, true, true])
    expect(result.map((item) => item.locked)).toEqual([false, false, false])
  })

  test("a rate-capped subscription still completes the AI step", () => {
    // It authenticated; it is simply at its quota. Blocking here stranded users
    // who hit their limit mid-setup on an account that works an hour later.
    expect(step("ai", {
      destination: "local",
      credentials: [{ ...verified, verification: "rate_capped" }],
    }).done).toBe(true)
  })

  test("an unverified or rejected credential does not complete the AI step", () => {
    for (const verification of ["auth_failed", "expired", "unverified"] as const) {
      expect(step("ai", { destination: "local", credentials: [{ ...verified, verification }] }).done).toBe(false)
    }
  })

  test("keeps a credential on another machine honest and actionable", () => {
    const ai = step("ai", {
      destination: "local",
      machineId: "machine-b",
      credentials: [{ ...verified, scope: "local", machineId: "machine-a" }],
    })

    expect(ai.done).toBe(false)
    expect(ai.cta).toEqual({ label: "Connect on this machine", action: "connect-ai" })
  })

  test("a Settings-driven credential update flips the AI step without onboarding-specific state", () => {
    let credentials: OnboardingStateInput["credentials"] = []
    const select = () => step("ai", { destination: "local", credentials })

    expect(select().done).toBe(false)
    credentials = [verified]
    expect(select().done).toBe(true)
  })

  test("every step still carries a verification, so done means proven", () => {
    expect(states().map((item) => item.verify)).toEqual(["destination", "credential", "remote-access"])
  })
})

describe("step ids and step actions are distinct vocabularies", () => {
  test("every step id is unique", () => {
    const ids = onboardingSteps.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("a CTA action is a verb, never a step id", () => {
    const ids = new Set<string>(onboardingSteps.map((item) => item.id))
    const actions = states({ destination: "both" }).map((item) => item.cta.action)

    expect(actions.filter((action) => ids.has(action))).toEqual([])
  })
})
