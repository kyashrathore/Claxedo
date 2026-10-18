import { describe, expect, test } from "bun:test"
import {
  FLAG_KEY_PATTERN,
  applyPending,
  audienceLabel,
  changeStat,
  createFlag,
  describeChange,
  effectiveSetting,
  envSummary,
  killSwitch,
  normalizeSetting,
  pendingChanges,
  pendingMarkdown,
  promotionWarnings,
  revertPending,
  searchFlags,
  seedFlags,
  stageEdits,
  unstage,
  validateFlagDraft,
  type FlagStore,
} from "./model"

const NOW = new Date("2026-10-18T09:00:00Z")
const LATER = "2026-10-18T10:00:00.000Z"

function flag(store: FlagStore, key: string) {
  const found = store.flags.find((entry) => entry.key === key)
  if (!found) throw new Error(`no flag ${key}`)
  return found
}

function row(store: FlagStore, env: "dev" | "staging" | "prod", key: string, edit: Record<string, unknown>) {
  return { key, ...effectiveSetting(store, env, flag(store, key)), ...edit }
}

describe("seed", () => {
  test("has twelve unique, valid flags and a starting audit trail", () => {
    const store = seedFlags(NOW)
    expect(store.flags).toHaveLength(12)
    expect(new Set(store.flags.map((entry) => entry.key)).size).toBe(12)
    for (const entry of store.flags) expect(entry.key).toMatch(new RegExp(FLAG_KEY_PATTERN))
    expect(store.audit).toHaveLength(3)
    expect(pendingChanges(store)).toHaveLength(0)
  })

  test("summarizes each environment", () => {
    const store = seedFlags(NOW)
    expect(envSummary(store, "dev")).toEqual({ on: 12, total: 12, pending: 0 })
    expect(envSummary(store, "prod")).toEqual({ on: 7, total: 12, pending: 0 })
  })
})

describe("normalizing edits", () => {
  const fallback = { enabled: false, rollout: 20, segments: ["beta"] }

  test("clamps rollout to 0–100 on the slider's 5% step", () => {
    expect(normalizeSetting({ rollout: 37 }, fallback).rollout).toBe(35)
    expect(normalizeSetting({ rollout: 38 }, fallback).rollout).toBe(40)
    expect(normalizeSetting({ rollout: 140 }, fallback).rollout).toBe(100)
    expect(normalizeSetting({ rollout: -5 }, fallback).rollout).toBe(0)
    expect(normalizeSetting({ rollout: "55" }, fallback).rollout).toBe(55)
  })

  test("keeps known segments in canonical order and falls back on missing fields", () => {
    expect(normalizeSetting({ segments: ["us", "nope", "internal"] }, fallback).segments).toEqual(["internal", "us"])
    expect(normalizeSetting({}, fallback)).toEqual(fallback)
    expect(normalizeSetting({ enabled: "yes", rollout: "x" }, fallback)).toEqual(fallback)
  })
})

describe("staging", () => {
  test("stages only rows that differ from the applied state", () => {
    const seed = seedFlags(NOW)
    const store = stageEdits(seed, "prod", [
      row(seed, "prod", "new-search-ranking", { enabled: true, rollout: 25 }),
      row(seed, "prod", "dark-mode-default", {}),
      { key: "ghost-flag", enabled: true },
    ])
    expect(Object.keys(store.staged.prod)).toEqual(["new-search-ranking"])
    expect(store.staged.dev).toEqual({})
    expect(flag(store, "new-search-ranking").envs.prod.enabled).toBe(false)
  })

  test("editing a row back to its applied state drops the staged change", () => {
    const seed = seedFlags(NOW)
    const staged = stageEdits(seed, "staging", [row(seed, "staging", "checkout-v2", { rollout: 75 })])
    expect(pendingChanges(staged)).toHaveLength(1)
    const back = stageEdits(staged, "staging", [row(seed, "staging", "checkout-v2", {})])
    expect(pendingChanges(back)).toHaveLength(0)
  })

  test("ignores a non-list payload and undoes one staged flag", () => {
    const seed = seedFlags(NOW)
    expect(stageEdits(seed, "dev", null)).toBe(seed)
    const staged = stageEdits(seed, "dev", [row(seed, "dev", "instant-refunds", { enabled: false }), row(seed, "dev", "checkout-v2", { rollout: 50 })])
    expect(Object.keys(unstage(staged, "dev", "instant-refunds").staged.dev)).toEqual(["checkout-v2"])
    expect(pendingChanges(revertPending(staged))).toHaveLength(0)
  })
})

describe("pending diff", () => {
  const seed = seedFlags(NOW)
  const store = stageEdits(
    stageEdits(seed, "prod", [
      row(seed, "prod", "new-search-ranking", { enabled: true, rollout: 25 }),
      row(seed, "prod", "legacy-cart-fallback", { enabled: false }),
      row(seed, "prod", "checkout-v2", { rollout: 20, segments: ["beta", "eu"] }),
    ]),
    "dev",
    [row(seed, "dev", "one-click-reorder", { segments: ["internal"] })],
  )

  test("orders changes by environment then flag and counts enables and disables", () => {
    const changes = pendingChanges(store)
    expect(changes.map((change) => `${change.env}:${change.key}`)).toEqual(["dev:one-click-reorder", "prod:checkout-v2", "prod:new-search-ranking", "prod:legacy-cart-fallback"])
    expect(changeStat(changes)).toEqual({ additions: 1, deletions: 1, updates: 2 })
  })

  test("describes each change in words", () => {
    const [dev, checkout, ranking, legacy] = pendingChanges(store)
    expect(describeChange(dev!)).toBe("targeting +Internal")
    expect(describeChange(checkout!)).toBe("rollout 10% → 20%, targeting +EU")
    expect(describeChange(ranking!)).toBe("enabled, rollout 0% → 25%")
    expect(describeChange(legacy!)).toBe("disabled")
  })

  test("warns when Production turns on a flag that Staging has off, unless Staging is staged on too", () => {
    expect(promotionWarnings(store, pendingChanges(store))).toEqual([])
    const fresh = stageEdits(seed, "prod", [row(seed, "prod", "one-click-reorder", { enabled: true, rollout: 10 })])
    expect(promotionWarnings(fresh, pendingChanges(fresh))).toEqual(["one-click-reorder turns on in Production while it is off in Staging."])
    const promoted = stageEdits(fresh, "staging", [row(fresh, "staging", "one-click-reorder", { enabled: true, rollout: 100 })])
    expect(promotionWarnings(promoted, pendingChanges(promoted))).toEqual([])
  })

  test("renders a markdown summary with a diff block", () => {
    const markdown = pendingMarkdown(store, pendingChanges(store))
    expect(markdown).toContain("**4 changes** across Development, Production: 1 enabled, 1 disabled, 2 retargeted.")
    expect(markdown).toContain("```diff")
    expect(markdown).toContain("- prod    new-search-ranking            Off")
    expect(markdown).toContain("+ prod    new-search-ranking            25% of everyone")
    expect(pendingMarkdown(seed, [])).toContain("Nothing is staged")
  })

  test("labels the audience of a setting", () => {
    expect(audienceLabel({ enabled: false, rollout: 50, segments: [] })).toBe("Off")
    expect(audienceLabel({ enabled: true, rollout: 50, segments: ["beta", "eu"] })).toBe("50% of Beta testers, EU")
  })
})

describe("applying", () => {
  test("writes staged settings, stamps them, records an audit row per change and clears the stage", () => {
    const seed = seedFlags(NOW)
    const staged = stageEdits(seed, "prod", [row(seed, "prod", "graphql-gateway", { enabled: true, rollout: 5, segments: ["internal"] })])
    const { store, applied } = applyPending(staged, LATER, "You")
    expect(applied).toHaveLength(1)
    expect(flag(store, "graphql-gateway").envs.prod).toEqual({ enabled: true, rollout: 5, segments: ["internal"], changedAt: LATER, changedBy: "You" })
    expect(flag(store, "graphql-gateway").envs.staging).toEqual(flag(seed, "graphql-gateway").envs.staging)
    expect(store.audit[0]).toEqual({ at: LATER, env: "prod", key: "graphql-gateway", change: "enabled, rollout 0% → 5%, targeting +Internal", actor: "You" })
    expect(store.audit).toHaveLength(4)
    expect(pendingChanges(store)).toHaveLength(0)
  })

  test("applying nothing changes nothing", () => {
    const seed = seedFlags(NOW)
    expect(applyPending(seed, LATER, "You")).toEqual({ store: seed, applied: [] })
  })
})

describe("kill switch", () => {
  test("turns off every production flag, keeps rollout, drops staged production edits and logs once", () => {
    const seed = seedFlags(NOW)
    const staged = stageEdits(stageEdits(seed, "prod", [row(seed, "prod", "graphql-gateway", { enabled: true })]), "dev", [row(seed, "dev", "checkout-v2", { rollout: 50 })])
    const { store, disabled } = killSwitch(staged, "prod", LATER, "You")
    expect(disabled).toHaveLength(7)
    expect(envSummary(store, "prod").on).toBe(0)
    expect(flag(store, "search-typo-tolerance").envs.prod.rollout).toBe(50)
    expect(store.staged.prod).toEqual({})
    expect(Object.keys(store.staged.dev)).toEqual(["checkout-v2"])
    expect(store.audit[0]?.key).toBe("7 flags")
    expect(store.audit[0]?.change).toContain("kill switch: disabled checkout-v2")
    expect(envSummary(store, "staging")).toEqual(envSummary(seed, "staging"))
  })

  test("is a recorded no-op when production is already dark", () => {
    const dark = killSwitch(seedFlags(NOW), "prod", LATER, "You").store
    const again = killSwitch(dark, "prod", LATER, "You")
    expect(again.disabled).toEqual([])
    expect(again.store.audit[0]?.change).toContain("nothing")
  })
})

describe("creating flags", () => {
  const seed = seedFlags(NOW)
  const draft = { key: "smart-shipping-eta", description: "Predict delivery windows per carrier.", owner: ["growth"] }

  test("accepts a valid draft and creates the flag off everywhere", () => {
    const checked = validateFlagDraft(seed, draft)
    if (!checked.ok) throw new Error(checked.error)
    const store = createFlag(seed, checked.draft, LATER, "You")
    const created = flag(store, "smart-shipping-eta")
    expect(created.owner).toBe("growth")
    expect([created.envs.dev.enabled, created.envs.staging.enabled, created.envs.prod.enabled]).toEqual([false, false, false])
    expect(store.audit[0]).toEqual({ at: LATER, env: "all", key: "smart-shipping-eta", change: "created, owned by Growth, off everywhere", actor: "You" })
  })

  test("rejects keys outside the pattern, duplicates, weak descriptions and unknown teams", () => {
    for (const key of ["Checkout", "9lives", "a", "has space", "under_score", "trailing-", "double--hyphen", ""]) {
      expect(validateFlagDraft(seed, { ...draft, key }).ok).toBe(false)
    }
    expect(validateFlagDraft(seed, { ...draft, key: "checkout-v2" })).toEqual({ ok: false, error: "A flag named checkout-v2 already exists." })
    expect(validateFlagDraft(seed, { ...draft, description: "short" }).ok).toBe(false)
    expect(validateFlagDraft(seed, { ...draft, owner: ["legal"] }).ok).toBe(false)
    expect(validateFlagDraft(seed, { ...draft, key: "x".repeat(65) }).ok).toBe(false)
  })
})

describe("search", () => {
  const { flags } = seedFlags(NOW)

  test("matches key, description, team and targeting with every term required", () => {
    expect(searchFlags(flags, "").length).toBe(12)
    expect(searchFlags(flags, "SEARCH").map((entry) => entry.key)).toEqual(["new-search-ranking", "search-typo-tolerance"])
    expect(searchFlags(flags, "payments refund").map((entry) => entry.key)).toEqual(["instant-refunds"])
    expect(searchFlags(flags, "enterprise").map((entry) => entry.key)).toEqual(["enterprise-sso-enforcement"])
    expect(searchFlags(flags, "beta").map((entry) => entry.key)).toEqual(["checkout-v2"])
    expect(searchFlags(flags, "zzz")).toHaveLength(0)
  })
})
