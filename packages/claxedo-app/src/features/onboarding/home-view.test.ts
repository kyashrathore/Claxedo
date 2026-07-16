import { describe, expect, test } from "bun:test"
import { onboardingState } from "./state"
import { onboardingHomeView } from "./home-view"

const state = onboardingState({
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
})

describe("onboarding Home view", () => {
  test("maps one registry into the setup card and selects its first live step", () => {
    const view = onboardingHomeView({ state, dismissals: [] })
    expect(view.mode).toBe("form")
    expect(view.activeStep).toBe("project")
    expect(view.steps.map((step) => [step.id, step.locked])).toEqual([
      ["project", false],
      ["ai", false],
      ["compute", true],
      ["remote-access", true],
    ])
  })

  test("a setup dismissal derives the compact checklist and a checklist dismissal hides it", () => {
    expect(onboardingHomeView({ state, dismissals: ["setup"] }).mode).toBe("checklist")
    expect(onboardingHomeView({ state, dismissals: ["setup", "checklist"] }).mode).toBe("hidden")
  })

  test("returning users keep the existing Home unchanged", () => {
    expect(onboardingHomeView({ state: { ...state, hasProject: true }, dismissals: [] }).mode).toBe("hidden")
  })

  test("go-further cards follow surface applicability and durable dismissal", () => {
    const view = onboardingHomeView({
      state: { ...state, hasFirstTurn: true },
      dismissals: ["gofurther:harnesses"],
    })
    expect(view.mode).toBe("go-further")
    expect(view.goFurtherCards.map((card) => card.id)).toEqual(["workgraph", "self-host"])
  })
})
