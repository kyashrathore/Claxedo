import { afterEach, describe, expect, test } from "bun:test"
import { removePersisted } from "@/platform/persistence/persist"
import {
  cloudSetupComplete,
  createLocalOnboardingDestination,
  destinationIncludesCloud,
  onboardingDestinationOptions,
  ONBOARDING_DESTINATION_TARGET,
} from "./destination"

afterEach(() => {
  removePersisted(ONBOARDING_DESTINATION_TARGET)
})

describe("onboarding destination choice", () => {
  test("starts unanswered so nothing cloud-shaped is offered on a guess", () => {
    expect(createLocalOnboardingDestination().destination()).toBeUndefined()
  })

  test("round-trips through Persist.global", async () => {
    const first = createLocalOnboardingDestination()
    await first.choose("cloud")

    expect(createLocalOnboardingDestination().destination()).toBe("cloud")
  })

  test("a later answer replaces the earlier one", async () => {
    const choice = createLocalOnboardingDestination()
    await choice.choose("cloud")
    await choice.choose("local")

    expect(createLocalOnboardingDestination().destination()).toBe("local")
  })
})

describe("cloud membership", () => {
  test("cloud and both want a cloud; local and unanswered do not", () => {
    expect(destinationIncludesCloud("cloud")).toBe(true)
    expect(destinationIncludesCloud("both")).toBe(true)
    expect(destinationIncludesCloud("local")).toBe(false)
    expect(destinationIncludesCloud(undefined)).toBe(false)
  })
})

describe("destination copy", () => {
  test("is one yes/no question, with yes first", () => {
    // Agents always run on this machine, so the question is whether to ADD the
    // cloud — not which of two places to pick.
    expect(onboardingDestinationOptions.map((option) => option.id)).toEqual(["both", "local"])
  })

  test("every choice states its consequence", () => {
    expect(onboardingDestinationOptions.every((option) => option.consequence.length > 0)).toBe(true)
  })

  test("the yes answer names the outcome first, then the work it takes", () => {
    // What the user GETS, then what they will DO — never our internal reasoning
    // or a hedge about who pays. The setup work is named up front so the
    // provider-credentials requirement never arrives as a surprise.
    const cloud = onboardingDestinationOptions.find((option) => option.id === "both")!
    expect(cloud.consequence).toContain("keep running after you close your laptop")
    expect(cloud.consequence).toContain("sandbox provider")
    expect(cloud.consequence).toContain("GitHub")
  })

  test("declining is reversible, and says so", () => {
    const local = onboardingDestinationOptions.find((option) => option.id === "local")!
    expect(local.consequence).toContain("logins you already have")
    expect(local.consequence).toContain("add the cloud later")
  })

  test("no option is written about our form or our convenience", () => {
    // The register the owner rejected: copy that explains what setup needs
    // rather than what the user gets.
    for (const option of onboardingDestinationOptions) {
      expect(option.consequence).not.toMatch(/setup (asks|needs)|this decides|we(\'ll)? need/i)
      expect(option.consequence).not.toMatch(/no Claxedo account|takes no cut/i)
    }
  })
})

describe("cloud readiness", () => {
  test("needs both halves — somewhere to run and something to clone", () => {
    expect(cloudSetupComplete({ sandboxProviderConfigured: true, codeHostConnected: true })).toBe(true)
    expect(cloudSetupComplete({ sandboxProviderConfigured: true, codeHostConnected: false })).toBe(false)
    expect(cloudSetupComplete({ sandboxProviderConfigured: false, codeHostConnected: true })).toBe(false)
  })
})
