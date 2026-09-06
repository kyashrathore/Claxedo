import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { docsPort, workSourcePort } from "./ports/index.js"
import type { IntegrationDeclaration, IntegrationImpl } from "./types.js"

const DECL: IntegrationDeclaration = {
  id: "fake",
  name: "Fake",
  methods: ["key"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

const docsImpl = (): IntegrationImpl => ({
  actions: { docs: docsPort },
  auth: { verify: async () => ({ ok: true }) },
})

describe("integration registry", () => {
  test("registers, resolves and lists declarations in registration order", () => {
    const registry = createIntegrationRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.byId("fake")).toBeUndefined()

    const impl = docsImpl()
    registry.register(DECL, impl)
    registry.register({ ...DECL, id: "other", name: "Other" }, { actions: { docs: docsPort } })

    expect(registry.list().map((decl) => decl.id)).toEqual(["fake", "other"])
    const entry = registry.byId("fake")
    expect(entry?.decl).toEqual({ ...DECL, capabilities: ["docs"] })
    // The registry hands back the registered impl itself — no copy, no wrapper.
    expect(entry?.impl).toBe(impl)
    expect(registry.byId("missing")).toBeUndefined()
  })

  test("derives capabilities from the ports the impl serves, not from the declaration", () => {
    const registry = createIntegrationRegistry()
    registry.register(DECL, {
      actions: { "work-source": workSourcePort, docs: docsPort },
    })

    // Declaration order is irrelevant: the set is read off CAPABILITIES, so two
    // impls serving the same ports always report the same list.
    expect(registry.byId("fake")?.decl.capabilities).toEqual(["docs", "work-source"])
  })

  test("refuses an integration that serves no capability", () => {
    const registry = createIntegrationRegistry()

    expect(() => registry.register(DECL, { actions: {} })).toThrow("integration serves no capability: fake")
    // A refused registration is not half-applied.
    expect(registry.list()).toEqual([])
    expect(registry.byId("fake")).toBeUndefined()
  })

  test("refuses a port filed under a capability it does not declare", () => {
    const registry = createIntegrationRegistry()

    // Only reachable from a host registering in JavaScript — TypeScript rejects
    // the same object at compile time — which is exactly why the check is here
    // and not left to the type system alone.
    expect(() =>
      registry.register(DECL, { actions: { docs: workSourcePort as unknown as typeof docsPort } }),
    ).toThrow("integration port filed under docs declares work-source")
  })

  test("refuses a duplicate id so a later registration cannot shadow an earlier one", async () => {
    const registry = createIntegrationRegistry()
    registry.register(DECL, docsImpl())

    expect(() =>
      registry.register({ ...DECL, name: "Impostor" }, {
        actions: { docs: docsPort },
        auth: { verify: async () => ({ ok: false, reason: "unauthorized" }) },
      }),
    ).toThrow("integration already registered: fake")

    // The rejected registration left nothing behind.
    expect(registry.list()).toHaveLength(1)
    expect(registry.byId("fake")?.decl.name).toBe("Fake")
    expect(await registry.byId("fake")!.impl.auth!.verify!({}, "any")).toEqual({ ok: true })
  })

  test("registries are independent instances (the kit holds no module-global state)", () => {
    const a = createIntegrationRegistry()
    const b = createIntegrationRegistry()
    a.register(DECL, docsImpl())

    expect(b.list()).toEqual([])
    expect(b.byId("fake")).toBeUndefined()
    // The same id registers cleanly in a second registry.
    expect(() => b.register(DECL, docsImpl())).not.toThrow()
    expect(a.list()).toHaveLength(1)
  })
})
