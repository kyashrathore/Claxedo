import { describe, expect, test } from "vitest"
import { getLoadoutRegistryEntry, resolveRegisteredLoadout } from "../src/model/loadout-registry"
import "../src/model/triage-modes"

describe("TriageMode loadouts", () => {
  test("registers all default modes with prompt templates and skillIds", () => {
    expect(["off", "light", "normal", "deep", "auto"].map((name) => getLoadoutRegistryEntry("triage_mode", name)?.name))
      .toEqual(["off", "light", "normal", "deep", "auto"])

    expect(resolveRegisteredLoadout("triage_mode", { name: "deep" }).payload).toEqual(expect.objectContaining({
      promptTemplate: expect.stringContaining("deeper triage"),
      skillIds: expect.arrayContaining(["grill-with-docs"]),
      decisionAggressiveness: "high",
    }))
  })

  test("auto selects a mode from intake signals", () => {
    expect(resolveRegisteredLoadout("triage_mode", { name: "auto" }, {
      type: "intake_item",
      intake: {
        id: "manual_1",
        kind: "manual",
        title: "Manual note",
        bodyMd: "Please clean up the sync bug.",
        status: "captured",
        repoRef: "github:acme/app",
        triageModeOverride: null,
        linkedSessionId: null,
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        lastTriagedAt: null,
      },
    }).name).toBe("normal")

    expect(resolveRegisteredLoadout("triage_mode", { name: "auto" }, {
      type: "intake_item",
      intake: {
        id: "slack_1",
        kind: "external",
        title: "Slack",
        bodyMd: "Button copy is confusing",
        status: "captured",
        repoRef: "github:acme/app",
        triageModeOverride: null,
        linkedSessionId: null,
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        lastTriagedAt: null,
      },
    }).name).toBe("light")
  })

  test("rejects invalid triage mode overrides", () => {
    expect(() => resolveRegisteredLoadout("triage_mode", {
      name: "normal",
      overrides: { evidenceThreshold: 2 },
    })).toThrow()
  })
})
