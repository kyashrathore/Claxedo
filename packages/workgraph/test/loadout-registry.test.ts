import { describe, expect, test } from "vitest"
import { z } from "zod"
import { getLoadoutRegistryEntry, registerLoadout, resolveRegisteredLoadout } from "../src/model/loadout-registry"
import "../src/model/triage-modes"

describe("loadout registry", () => {
  test("rejects duplicate registrations for the same kind and name", () => {
    registerLoadout("model", "fast-test", z.object({ model: z.string() }), { model: "small" })

    expect(() => registerLoadout("model", "fast-test", z.object({ model: z.string() }), { model: "small" }))
      .toThrow("Loadout 'model:fast-test' is already registered")
  })

  test("validates overrides against the registered schema at resolve time", () => {
    registerLoadout("harness", "strict-test", z.object({
      retries: z.number().int().min(0),
    }), { retries: 1 })

    expect(() => resolveRegisteredLoadout("harness", {
      name: "strict-test",
      overrides: { retries: "many" },
    })).toThrow()
  })

  test("registers built-in triage modes including auto", () => {
    expect(getLoadoutRegistryEntry("triage_mode", "off")?.name).toBe("off")
    expect(getLoadoutRegistryEntry("triage_mode", "light")?.name).toBe("light")
    expect(getLoadoutRegistryEntry("triage_mode", "normal")?.name).toBe("normal")
    expect(getLoadoutRegistryEntry("triage_mode", "deep")?.name).toBe("deep")
    expect(getLoadoutRegistryEntry("triage_mode", "auto")?.name).toBe("auto")
  })
})
