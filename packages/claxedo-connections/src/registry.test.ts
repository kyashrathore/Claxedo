import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import type { IntegrationDeclaration, IntegrationImpl } from "./types.js"

const DECL: IntegrationDeclaration = {
  id: "fake",
  name: "Fake",
  methods: ["key"],
  capabilities: ["docs"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

describe("integration registry", () => {
  test("registers, resolves and lists declarations in registration order", () => {
    const registry = createIntegrationRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.byId("fake")).toBeUndefined()

    const impl: IntegrationImpl = { verify: async () => ({ ok: true }) }
    registry.register(DECL, impl)
    registry.register({ ...DECL, id: "other", name: "Other" }, {})

    expect(registry.list().map((decl) => decl.id)).toEqual(["fake", "other"])
    const entry = registry.byId("fake")
    expect(entry?.decl).toEqual(DECL)
    // The registry hands back the registered impl itself — no copy, no wrapper.
    expect(entry?.impl).toBe(impl)
    expect(registry.byId("missing")).toBeUndefined()
  })

  test("refuses a duplicate id so a later registration cannot shadow an earlier one", async () => {
    const registry = createIntegrationRegistry()
    registry.register(DECL, { verify: async () => ({ ok: true }) })

    expect(() =>
      registry.register({ ...DECL, name: "Impostor" }, { verify: async () => ({ ok: false, reason: "unauthorized" }) }),
    ).toThrow("integration already registered: fake")

    // The rejected registration left nothing behind.
    expect(registry.list()).toHaveLength(1)
    expect(registry.byId("fake")?.decl.name).toBe("Fake")
    expect(await registry.byId("fake")!.impl.verify!({}, "any")).toEqual({ ok: true })
  })

  test("registries are independent instances (the kit holds no module-global state)", () => {
    const a = createIntegrationRegistry()
    const b = createIntegrationRegistry()
    a.register(DECL, {})

    expect(b.list()).toEqual([])
    expect(b.byId("fake")).toBeUndefined()
    // The same id registers cleanly in a second registry.
    expect(() => b.register(DECL, {})).not.toThrow()
    expect(a.list()).toHaveLength(1)
  })
})
