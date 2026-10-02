import { expect, test } from "bun:test"
import type { ModelSettings } from "@claxedo/harness/contract"
import { FakeTransport } from "../test-support/fake-transport"
import { controlledTurn, createHostFixture, LOOPBACK_ORIGIN, sessionCreate, until } from "../test-support/host-fixture"

test("live settings acknowledge before persistence, recover after refusal, and keep the current turn", async () => {
  const control = controlledTurn("ses_model")
  const changes: ModelSettings[] = []
  const accepted = Promise.withResolvers<void>()
  const refused = new Error("native refusal")
  const transport = new FakeTransport({ turn: () => control.events, config: {
    options: async () => ({ options: [] }), permissionModes: async () => ({ modes: [], appliesFrom: "next-turn" }),
    setPermissionMode: async () => ({ modes: [], appliesFrom: "next-turn" }),
    setModelSettings: async (_session, settings) => {
      changes.push(settings)
      if (settings.model?.modelID === "refused") throw refused
      if (settings.model?.modelID === "next") await accepted.promise
    },
  } })
  const fixture = createHostFixture({ transports: { claude: transport } })
  try {
    const session = await fixture.runtime.sessions.create({ ...sessionCreate({ id: "ses_model", harness: { id: "claude", access: "native" } }),
      model: { providerID: "anthropic", modelID: "first" }, variant: "low" })
    await fixture.runtime.turns.start({ sessionId: session.id, text: "continue working", origin: LOOPBACK_ORIGIN })
    await until(() => transport.activeTurns === 1)
    await expect(fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "refused" } })).rejects.toBe(refused)
    expect(fixture.store.getSessionConfig(session.id)?.model?.modelID).toBe("first")
    const updating = fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "next" }, variant: "high" })
    await until(() => changes.length === 2)
    expect(fixture.store.getSessionConfig(session.id)?.model?.modelID).toBe("first")
    accepted.resolve()
    expect(await updating).toMatchObject({ model: { modelID: "next" }, variant: "high" })
    await fixture.runtime.sessions.updateConfig(session.id, { variant: "low" })
    await fixture.runtime.sessions.updateConfig(session.id, { variant: null })
    await fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "next" }, variant: null })
    expect(changes).toHaveLength(4)
    expect(changes.slice(-2)).toEqual([{ model: { providerID: "anthropic", modelID: "next" }, effort: "low" },
      { model: { providerID: "anthropic", modelID: "next" }, effort: undefined }])
    expect(transport.activeTurns).toBe(1)
    expect(transport.turns).toHaveLength(1)
    expect(transport.closed).toHaveLength(0)
    expect(transport.cancels).toHaveLength(0)
    control.finish()
    await fixture.runtime.turns.whenIdle(session.id)
    expect(fixture.store.getSessionConfig(session.id)).toMatchObject({ model: { modelID: "next" } })
  } finally { control.finish(); await fixture.dispose() }
})

test("a harness that owns its configuration keeps that single update path", async () => {
  const updates: unknown[] = []
  const transport = new FakeTransport({ config: {
    options: async () => ({ options: [] }), permissionModes: async () => ({ modes: [], appliesFrom: "immediate" }),
    setPermissionMode: async () => ({ modes: [], appliesFrom: "immediate" }),
    setModelSettings: async () => { throw new Error("duplicate native config write") },
  }, harnessConfig: {
    read: async () => ({ harness: { id: "proof", access: "connection" } }),
    update: async (_session, update) => {
      updates.push(update)
      return { harness: { id: "proof", access: "connection" }, model: update.model ?? undefined, variant: update.variant ?? undefined }
    },
  } })
  const fixture = createHostFixture({ transports: { proof: transport } })
  try {
    const session = await fixture.runtime.sessions.create(sessionCreate({ harness: { id: "proof", access: "connection" } }))
    const update = { model: { providerID: "proof", modelID: "next" }, variant: "high" }
    expect(await fixture.runtime.sessions.updateConfig(session.id, update)).toMatchObject(update)
    expect(updates).toEqual([update])
  } finally { await fixture.dispose() }
})
