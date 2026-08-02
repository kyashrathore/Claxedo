import { afterEach, describe, expect, test } from "bun:test"
import { removePersisted } from "@/platform/persistence/persist"
import {
  createHostedOnboardingDismissals,
  createLocalOnboardingDismissals,
  ONBOARDING_DISMISSALS_TARGET,
  type HostedOnboardingDismissalKV,
  type OnboardingDismissalId,
} from "./dismissals"

afterEach(() => {
  removePersisted(ONBOARDING_DISMISSALS_TARGET)
})

describe("local onboarding dismissals", () => {
  test("round-trips through Persist.global and never respawns a dismissed card", async () => {
    const first = createLocalOnboardingDismissals()
    await first.dismiss("setup")

    const reloaded = createLocalOnboardingDismissals()

    expect(reloaded.ids()).toEqual(["setup"])
    expect(reloaded.isDismissed("setup")).toBe(true)
    expect(reloaded.isDismissed("checklist")).toBe(false)
  })
})

describe("hosted onboarding dismissals", () => {
  test("round-trips through per-user KV and keeps users isolated", async () => {
    const records = new Map<string, readonly OnboardingDismissalId[]>()
    const kv: HostedOnboardingDismissalKV = {
      get: async (userId) => records.get(userId),
      set: async (userId, ids) => {
        records.set(userId, ids)
      },
    }

    const first = createHostedOnboardingDismissals("user-a", kv)
    await first.dismiss("gofurther:workgraph")

    const reloaded = createHostedOnboardingDismissals("user-a", kv)
    const otherUser = createHostedOnboardingDismissals("user-b", kv)
    await Promise.all([reloaded.loaded, otherUser.loaded])

    expect(reloaded.isDismissed("gofurther:workgraph")).toBe(true)
    expect(otherUser.isDismissed("gofurther:workgraph")).toBe(false)
  })

  test("does not claim a failed hosted write and can retry it", async () => {
    let fail = true
    const stored: OnboardingDismissalId[] = []
    const kv: HostedOnboardingDismissalKV = {
      get: async () => stored,
      set: async (_userId, ids) => {
        if (fail) throw new Error("KV unavailable")
        stored.splice(0, stored.length, ...ids)
      },
    }
    const dismissals = createHostedOnboardingDismissals("user-a", kv)

    await expect(dismissals.dismiss("checklist")).rejects.toThrow("KV unavailable")
    await dismissals.loaded
    expect(dismissals.isDismissed("checklist")).toBe(false)

    fail = false
    await dismissals.dismiss("checklist")
    expect(dismissals.isDismissed("checklist")).toBe(true)
  })
})
