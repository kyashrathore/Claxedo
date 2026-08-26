import { describe, expect, test } from "bun:test"
import { onboardingState, type OnboardingStateInput } from "./state"
import { onboardingHomeView } from "./home-view"

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

const stateOf = (input: Partial<OnboardingStateInput> = {}) => onboardingState({ ...base, ...input })

/** Unanswered: the flow has not started. */
const state = stateOf()

/** A user who said yes to the cloud and has everything it needs. */
const withCloud = stateOf({
  credentials: [{ id: "cred_1", providerId: "anthropic", verification: "ok", scope: "local", machineId: "machine-a" }],
  hasProject: true,
  destination: "both",
  sandboxProviderConfigured: true,
  codeHostConnected: true,
})

/** The same machine, by a user who declined the cloud. */
const localOnly = onboardingState({ ...base, ...withCloud, destination: "local" })

describe("onboarding Home view", () => {
  test("opens on the cloud question", () => {
    const view = onboardingHomeView({ state, dismissals: [] })
    expect(view.mode).toBe("form")
    expect(view.location).toEqual({ kind: "step", step: "destination" })
    expect(view.steps.map((step) => step.id)).toEqual(["destination", "ai", "remote-access"])
  })

  test("the rail is the same three steps either way — the answer changes the screen, not the flow", () => {
    // Cloud setup lives inside the first step now, so saying yes deepens that
    // screen rather than growing the rail out from under the user.
    expect(onboardingHomeView({ state: withCloud, dismissals: [] }).steps.map((step) => step.id)).toEqual([
      "destination",
      "ai",
      "remote-access",
    ])
    expect(onboardingHomeView({ state: localOnly, dismissals: [] }).steps.map((step) => step.id)).toEqual([
      "destination",
      "ai",
      "remote-access",
    ])
  })

  test("only remote access is skippable", () => {
    expect(
      onboardingHomeView({ state: withCloud, dismissals: [] }).steps.map((step) => [step.id, step.optional]),
    ).toEqual([
      ["destination", false],
      ["ai", false],
      ["remote-access", true],
    ])
  })

  test("a setup dismissal derives the compact checklist and a checklist dismissal hides it", () => {
    expect(onboardingHomeView({ state, dismissals: ["setup"] }).mode).toBe("checklist")
    expect(onboardingHomeView({ state, dismissals: ["setup", "checklist"] }).mode).toBe("hidden")
  })

  test("returning users keep the existing Home unchanged", () => {
    expect(
      onboardingHomeView({
        state: stateOf({
          hasProject: true,
          credentials: [{ id: "cred_1", providerId: "anthropic", verification: "ok", scope: "shared" }],
        }),
        dismissals: [],
      }).mode,
    ).toBe("hidden")
  })

  test("a web-hosted local destination hands off after a local harness is proven", () => {
    const view = onboardingHomeView({
      state: stateOf({
        surface: "web",
        destination: "local",
        hasProject: true,
        runnableHarnesses: ["codex"],
      }),
      dismissals: [],
    })

    expect(view.mode).toBe("hidden")
  })

  test("declining the cloud holds the user on the first step until a project is open", () => {
    // The picker lives in that branch, so the step is where the folder is
    // chosen rather than a screen the user is pushed past.
    expect(onboardingHomeView({ state: stateOf({ destination: "local" }), dismissals: [] }).location).toEqual({
      kind: "step",
      step: "destination",
    })
  })

  test("an answered first step advances to the AI step once it is satisfied", () => {
    const view = onboardingHomeView({ state: stateOf({ destination: "local", hasProject: true }), dismissals: [] })
    expect(view.mode).toBe("form")
    expect(view.location).toEqual({ kind: "step", step: "ai" })
  })

  test("saying yes holds the user on the first step until the cloud can actually run", () => {
    const view = onboardingHomeView({ state: stateOf({ destination: "both" }), dismissals: [] })
    expect(view.location).toEqual({ kind: "step", step: "destination" })
  })

  test("lands on remote access once the cloud and the AI are settled", () => {
    const view = onboardingHomeView({
      state: { ...withCloud, hasUsableCredential: true, credentialAvailability: "available" },
      dismissals: [],
    })
    expect(view.location).toEqual({ kind: "step", step: "remote-access" })
  })

  test("a deep link to a step locked behind the first question falls back to it", () => {
    const view = onboardingHomeView({ state, dismissals: [], requestedStep: "ai" })
    expect(view.location).toEqual({ kind: "step", step: "destination" })
  })

  test("an AI deep link cannot bypass incomplete cloud destination setup", () => {
    const view = onboardingHomeView({
      state: stateOf({
        destination: "both",
        hasProject: true,
        credentials: [{ id: "cred_1", providerId: "anthropic", verification: "ok", scope: "shared" }],
      }),
      dismissals: [],
      requestedStep: "ai",
    })
    expect(view.location).toEqual({ kind: "step", step: "destination" })
    expect(view.steps.find((step) => step.id === "ai")?.locked).toBe(true)
  })

  test("an applicable deep link is honoured", () => {
    const view = onboardingHomeView({ state: localOnly, dismissals: [], requestedStep: "ai" })
    expect(view.location).toEqual({ kind: "step", step: "ai" })
  })

  test("remaining counts the steps still wanting attention", () => {
    // The first question and remote access are both reachable; the AI step is
    // locked behind the first, so it is rail progress rather than work now.
    expect(onboardingHomeView({ state, dismissals: [] }).remaining).toBe(2)
    // withCloud has its cloud and its credential, leaving only remote access.
    expect(onboardingHomeView({ state: withCloud, dismissals: [] }).remaining).toBe(1)
  })

  test("skipping remote access clears the last of the work", () => {
    expect(onboardingHomeView({ state: withCloud, dismissals: ["step:remote-access"] }).remaining).toBe(0)
  })

  test("Next on the final optional step reaches the done recap", () => {
    // Reported live: Next was enabled on remote-access, the last step, and did
    // nothing — location re-derived to the same unfinished optional step, so
    // the only way out was Skip.
    const ready = { ...withCloud, hasUsableCredential: true, credentialAvailability: "available" as const }
    expect(onboardingHomeView({ state: ready, dismissals: [] }).location).toEqual({
      kind: "step",
      step: "remote-access",
    })

    expect(onboardingHomeView({ state: ready, dismissals: [], passedOver: ["remote-access"] }).location).toEqual({
      kind: "done",
    })
  })

  test("passing over is for this pass only — Skip is what stops the asking", () => {
    const ready = { ...withCloud, hasUsableCredential: true, credentialAvailability: "available" as const }

    // A dismissal marks the rail row skipped and survives to the next visit.
    const skipped = onboardingHomeView({ state: ready, dismissals: ["step:remote-access"] })
    expect(skipped.steps.find((step) => step.id === "remote-access")!.skipped).toBe(true)

    // Next records nothing: the row is untouched, and a fresh view — one with
    // no passedOver, as a later visit would build — offers the step again.
    const passed = onboardingHomeView({ state: ready, dismissals: [], passedOver: ["remote-access"] })
    expect(passed.steps.find((step) => step.id === "remote-access")!.skipped).toBe(false)
    expect(onboardingHomeView({ state: ready, dismissals: [] }).location).toEqual({
      kind: "step",
      step: "remote-access",
    })
  })

  test("passing over a step never marks it done", () => {
    // Next is trapped on unfinished REQUIRED steps by nextBlockedReason, so
    // this path is only reachable for optional ones. Either way the step stays
    // unfinished: moving past it is a navigation choice, not progress.
    const view = onboardingHomeView({ state, dismissals: [], passedOver: ["destination"] })
    expect(view.steps.find((step) => step.id === "destination")!.done).toBe(false)
    // It also stays locked behind its own answer — the AI step is not reachable
    // just because the user moved off the question it depends on.
    expect(view.steps.find((step) => step.id === "ai")!.locked).toBe(true)
  })

  test("go-further cards follow surface applicability and durable dismissal", () => {
    const view = onboardingHomeView({
      state: { ...state, hasFirstTurn: true },
      dismissals: ["gofurther:harnesses"],
    })
    expect(view.mode).toBe("go-further")
    // Remote access graduated to a setup step, so it is no longer a card.
    expect(view.goFurtherCards.map((card) => card.id)).toEqual(["workgraph", "self-host"])
  })
})
