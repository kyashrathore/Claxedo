import { storePath } from "solid-js"
import { Persist, persisted } from "@/platform/persistence/persist"
import type { Accessor } from "solid-js"
import { createStore } from "solid-js"
import type { OnboardingDestination } from "./ai-connect-state"

/**
 * Where this user's agents will run.
 *
 * A goal, not a fact we can observe. The shipped flow inferred it from a
 * configured sandbox provider, which is right for a returning user and circular
 * for a new one: the provider is configured from a step that stays hidden until
 * the provider is configured. Asking breaks the cycle.
 *
 * Undefined means unanswered — every cloud step stays absent until the answer
 * exists, so nothing is offered on a guess.
 */
export type OnboardingDestinationChoice = {
  destination: Accessor<OnboardingDestination | undefined>
  ready: Accessor<boolean>
  loaded: Promise<void>
  choose: (destination: OnboardingDestination) => Promise<void>
}

export const ONBOARDING_DESTINATION_TARGET = Persist.global("onboarding.destination.v1")

export function createLocalOnboardingDestination(): OnboardingDestinationChoice {
  const [store, setStore, init, ready] = persisted(
    ONBOARDING_DESTINATION_TARGET,
    createStore<{ destination: OnboardingDestination | null }>({ destination: null }),
  )
  const loaded = Promise.resolve(init).then(() => undefined)

  return {
    destination: () => store.destination ?? undefined,
    ready,
    loaded,
    choose: async (destination) => {
      await loaded
      setStore(storePath("destination", destination))
    },
  }
}

export function destinationIncludesCloud(destination: OnboardingDestination | undefined) {
  return destination === "cloud" || destination === "both"
}

export type OnboardingDestinationOption = {
  id: OnboardingDestination
  label: string
  /** What choosing this commits the user to, stated before they choose it. */
  consequence: string
}

/**
 * One question with two answers: cloud sessions as well as local ones, or not.
 *
 * Agents always run on this machine — that half needs no permission and no
 * setup. So the question is whether to add the cloud, and yes is additive
 * rather than a switch away from local. Each answer names what the user gets
 * and what they will do next; the yes row says up front that it needs sandbox
 * provider credentials, so nothing about the cost arrives as a surprise.
 */
export const onboardingDestinationOptions: readonly OnboardingDestinationOption[] = [
  {
    id: "both",
    label: "Yes, run cloud sessions too",
    consequence:
      "Sessions keep running after you close your laptop. You'll set up a sandbox provider and connect GitHub.",
  },
  {
    id: "local",
    label: "No, just this machine",
    consequence: "Sessions run here and use the logins you already have. You can add the cloud later.",
  },
]

/** Whether the cloud answer has everything it needs to actually run a session. */
export function cloudSetupComplete(input: { sandboxProviderConfigured: boolean; codeHostConnected: boolean }) {
  return input.sandboxProviderConfigured && input.codeHostConnected
}
