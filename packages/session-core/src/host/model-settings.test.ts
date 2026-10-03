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

const EFFORTS: Record<string, string[]> = { opus: ["low", "high", "max"], sonnet: ["low", "high", "max"], haiku: [] }

function catalogTransport(changes: ModelSettings[], hold?: Promise<void>) {
  return new FakeTransport({ config: {
    options: async (target) => {
      const efforts = EFFORTS["session" in target ? target.model?.modelID ?? "" : ""] ?? []
      return { options: efforts.length ? [{ id: "effort", category: "thought_level", type: "select", selectOptions: efforts.map((id) => ({ id })) }] : [] }
    },
    permissionModes: async () => ({ modes: [], appliesFrom: "next-turn" }),
    setPermissionMode: async () => ({ modes: [], appliesFrom: "next-turn" }),
    setModelSettings: async (_session, settings) => {
      if (settings.effort && !EFFORTS[settings.model?.modelID ?? ""]?.includes(settings.effort)) {
        throw new Error(`${settings.model?.modelID} does not run at effort ${settings.effort}`)
      }
      changes.push(settings)
      if (settings.model?.modelID === "opus") await hold
    },
  } })
}

test("a model-only change keeps the saved effort the new model offers and drops one it does not", async () => {
  const changes: ModelSettings[] = []
  const fixture = createHostFixture({ transports: { claude: catalogTransport(changes) } })
  try {
    const session = await fixture.runtime.sessions.create({ ...sessionCreate({ id: "ses_effort", harness: { id: "claude", access: "native" } }),
      model: { providerID: "anthropic", modelID: "opus" }, variant: "max" })
    expect(await fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "sonnet" } }))
      .toMatchObject({ model: { modelID: "sonnet" }, variant: "max" })
    expect(await fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "haiku" } }))
      .toMatchObject({ model: { modelID: "haiku" }, variant: null })
    expect(fixture.store.getSessionConfig(session.id)).toMatchObject({ model: { modelID: "haiku" }, variant: null })
    expect(changes).toEqual([{ model: { providerID: "anthropic", modelID: "sonnet" }, effort: "max" },
      { model: { providerID: "anthropic", modelID: "haiku" }, effort: undefined }])
    await expect(fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "opus" }, variant: "max" }))
      .resolves.toMatchObject({ variant: "max" })
    await expect(fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "haiku" }, variant: "max" }))
      .rejects.toThrow("haiku does not run at effort max")
  } finally { await fixture.dispose() }
})

test("overlapping config writes of one session apply in order without reverting each other", async () => {
  const changes: ModelSettings[] = []
  const held = Promise.withResolvers<void>()
  const fixture = createHostFixture({ transports: { claude: catalogTransport(changes, held.promise) } })
  try {
    const session = await fixture.runtime.sessions.create({ ...sessionCreate({ id: "ses_overlap", harness: { id: "claude", access: "native" } }),
      model: { providerID: "anthropic", modelID: "sonnet" }, variant: "low" })
    const model = fixture.runtime.sessions.updateConfig(session.id, { model: { providerID: "anthropic", modelID: "opus" } })
    await until(() => changes.length === 1)
    const effort = fixture.runtime.sessions.updateConfig(session.id, { variant: "high" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(changes).toHaveLength(1)
    held.resolve()
    await Promise.all([model, effort])
    expect(changes).toEqual([{ model: { providerID: "anthropic", modelID: "opus" }, effort: "low" },
      { model: { providerID: "anthropic", modelID: "opus" }, effort: "high" }])
    expect(fixture.store.getSessionConfig(session.id)).toMatchObject({ model: { modelID: "opus" }, variant: "high" })
  } finally { held.resolve(); await fixture.dispose() }
})
