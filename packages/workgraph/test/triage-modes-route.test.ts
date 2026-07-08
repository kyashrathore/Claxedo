import { describe, expect, test } from "vitest"
import Database from "better-sqlite3"
import { z } from "zod"
import { createApp, initializeDb } from "../src/app"
import { registerLoadout } from "../src/model/loadout-registry"
import { resetWorkGraph } from "../src/model/registry"

describe("Triage modes route", () => {
  test("GET /triage-modes returns built-in modes without skill internals", async () => {
    resetWorkGraph()
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)

    const res = await app.request("/triage-modes")

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.modes.map((mode: { name: string }) => mode.name).sort()).toEqual([
      "auto",
      "deep",
      "light",
      "normal",
      "off",
    ])
    expect(body.modes.find((mode: { name: string }) => mode.name === "deep")).toEqual(expect.objectContaining({
      name: "deep",
      description: expect.any(String),
      defaults: expect.objectContaining({
        decisionAggressiveness: "high",
        evidenceThreshold: 0.5,
        outputBudget: 12000,
      }),
      requiresExplicitOverride: false,
    }))
    expect(JSON.stringify(body)).not.toContain("skillIds")
    expect(JSON.stringify(body)).not.toContain("promptTemplate")
  })

  test("GET /triage-modes includes registered custom modes", async () => {
    resetWorkGraph()
    registerLoadout("triage_mode", "grill-me", z.object({
      promptTemplate: z.string(),
      skillIds: z.array(z.string()),
      decisionAggressiveness: z.string(),
      evidenceThreshold: z.number(),
      outputBudget: z.number(),
      requiresExplicitOverride: z.boolean(),
      description: z.string(),
    }), {
      promptTemplate: "Ask hard questions.",
      skillIds: ["grill-me"],
      decisionAggressiveness: "high",
      evidenceThreshold: 0.7,
      outputBudget: 4000,
      requiresExplicitOverride: true,
      description: "Challenge the intake before planning.",
    })
    const db = new Database(":memory:")
    initializeDb(db)
    const app = createApp(db)

    const res = await app.request("/triage-modes")
    const body = await res.json()

    expect(body.modes).toContainEqual(expect.objectContaining({
      name: "grill-me",
      description: "Challenge the intake before planning.",
      requiresExplicitOverride: true,
    }))
  })
})
