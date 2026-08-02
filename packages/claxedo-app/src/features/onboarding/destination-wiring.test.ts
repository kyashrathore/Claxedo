import { afterEach, describe, expect, test } from "bun:test"
import { removePersisted } from "@/platform/persistence/persist"
import { destinationStoresCredentials } from "./ai-connect-state"
import {
  createLocalOnboardingDestination,
  destinationIncludesCloud,
  ONBOARDING_DESTINATION_TARGET,
} from "./destination"
import { onboardingHomeView } from "./home-view"
import { onboardingState, type OnboardingStateInput } from "./state"

afterEach(() => {
  removePersisted(ONBOARDING_DESTINATION_TARGET)
})

const base = {
  surface: "desktop",
  machineId: "machine-a",
  credentials: [],
  runnableHarnesses: [],
  hasProject: true,
  sandboxProviderConfigured: false,
  hasFirstTurn: false,
  hasFirstCloudTurn: false,
  hostedSignedIn: false,
  remoteAccessEnabled: false,
  secondDeviceOpen: false,
} satisfies OnboardingStateInput

/**
 * The seam B1–B4 exist to build: the persisted answer to step 0 is what decides
 * the flow's shape and whether the AI step stores anything — replacing the
 * inference from `sandboxProviderConfigured` that made the flow circular.
 */
describe("the destination answer drives the whole flow", () => {
  test("a saved answer survives a reload and shapes the steps it comes back to", async () => {
    const choice = createLocalOnboardingDestination()
    await choice.choose("local")

    const reloaded = createLocalOnboardingDestination()
    const view = onboardingHomeView({
      state: onboardingState({ ...base, destination: reloaded.destination() }),
      dismissals: [],
    })

    expect(view.location).toEqual({ kind: "step", step: "ai" })
  })

  test("local stores no credential; cloud and both do", () => {
    expect(destinationStoresCredentials("local")).toBe(false)
    expect(destinationStoresCredentials("cloud")).toBe(true)
    expect(destinationStoresCredentials("both")).toBe(true)
  })

  test("the same machine yields different work for different answers", () => {
    // Identical state in every respect except the answer — which is the point:
    // wanting a cloud is a goal we cannot observe, only ask for.
    const settled = (destination: OnboardingStateInput["destination"]) =>
      onboardingHomeView({ state: onboardingState({ ...base, destination }), dismissals: [] })
        .steps.find((step) => step.id === "destination")!.done

    // Declining needs nothing further; accepting still owes a key and a repo.
    expect(settled("local")).toBe(true)
    expect(settled("cloud")).toBe(false)
  })

  test("a configured sandbox provider no longer summons cloud steps on its own", () => {
    // The inference this replaced: having a provider key was read as "wants
    // cloud", which could not tell a local user apart from an unfinished one.
    const view = onboardingHomeView({
      state: onboardingState({ ...base, destination: "local", sandboxProviderConfigured: true }),
      dismissals: [],
    })

    // A local user is not held on the first step by a key they never asked for.
    expect(view.steps.find((step) => step.id === "destination")!.done).toBe(true)
  })

  test("only a cloud answer opens the cloud setup form", () => {
    expect(destinationIncludesCloud("local")).toBe(false)
    expect(destinationIncludesCloud("cloud")).toBe(true)
    expect(destinationIncludesCloud("both")).toBe(true)
    // Unanswered must not fetch the provider catalog or the connection list
    // either — those wait for an answer that asks for them.
    expect(destinationIncludesCloud(undefined)).toBe(false)
  })
})
