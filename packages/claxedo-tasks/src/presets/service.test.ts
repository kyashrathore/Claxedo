import { beforeEach, describe, expect, test } from "bun:test"
import { createMemoryTasksStore } from "../stores/memory"
import { ACTOR, OTHER_ACTOR, OTHER_SCOPE, fakeCapabilities, fakeClock, fakeIds } from "../test-support/fakes"
import { fieldReasons, refusalOf } from "../test-support/refusals"
import { presetDraft, primaryConfiguration } from "../test-support/rows"
import type { TasksCapabilitiesPort } from "../ports/capabilities"
import type { TasksStorePort } from "../ports/store"
import { createPresetsService, type PresetsService } from "./service"

const CLOUD = {
  placement: "cloud",
  capabilities: { mode: "selected", plugins: [{ sourceId: "claxedo", pluginName: "review" }], skills: [] },
} as const

function serviceOver(store: TasksStorePort, capabilities: TasksCapabilitiesPort = fakeCapabilities()): PresetsService {
  return createPresetsService({ store, clock: fakeClock(), ids: fakeIds(), capabilities })
}

describe("presets service", () => {
  let store: TasksStorePort
  let presets: PresetsService

  beforeEach(() => {
    store = createMemoryTasksStore()
    presets = serviceOver(store)
  })

  test("creates a preset at revision 1 owned by the actor", async () => {
    const preset = await presets.create(ACTOR, presetDraft({ name: "Careful" }))
    expect(preset).toMatchObject({
      revision: 1,
      scopeId: ACTOR.scopeId,
      ownerId: ACTOR.ownerId,
      name: "Careful",
      archivedAt: null,
    })
    expect(await presets.get(ACTOR, preset.id)).toEqual(preset)
  })

  test("refuses an invalid draft with the fields that failed", async () => {
    const detail = await refusalOf(() => presets.create(ACTOR, presetDraft({ name: "" })))
    expect(detail.code).toBe("invalid_input")
    expect(fieldReasons(detail)).toEqual({ name: "required" })
  })

  test("refuses a placement the host does not support", async () => {
    const localOnly = serviceOver(store, fakeCapabilities({ placements: ["local"] }))
    const detail = await refusalOf(() => localOnly.create(ACTOR, presetDraft({ execution: CLOUD })))
    expect(detail.code).toBe("unsupported")
  })

  test("refuses a selected cloud set on a host that cannot enforce one", async () => {
    const unenforced = serviceOver(store, fakeCapabilities({ cloudSelectedCapabilities: false }))
    const detail = await refusalOf(() => unenforced.create(ACTOR, presetDraft({ execution: CLOUD })))
    expect(detail.code).toBe("unsupported")
  })

  test("another owner in the same scope cannot read the preset", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    const detail = await refusalOf(() => presets.get(OTHER_ACTOR, preset.id))
    expect(detail.code).toBe("not_found")
    expect(detail.message).not.toContain("Local preset")
  })

  test("another scope cannot read the preset", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    expect((await refusalOf(() => presets.get(OTHER_SCOPE, preset.id))).code).toBe("not_found")
  })

  test("lists only the actor's own presets, archived ones on request", async () => {
    const kept = await presets.create(ACTOR, presetDraft({ name: "Kept" }))
    const gone = await presets.create(ACTOR, presetDraft({ name: "Gone" }))
    await presets.create(OTHER_ACTOR, presetDraft({ name: "Theirs" }))
    await presets.archive(ACTOR, { presetId: gone.id, revision: gone.revision })

    const open = await presets.list(ACTOR, { cursor: null, limit: 50, includeArchived: false })
    expect(open.items.map((preset) => preset.id)).toEqual([kept.id])

    const all = await presets.list(ACTOR, { cursor: null, limit: 50, includeArchived: true })
    expect(all.items.map((preset) => preset.name).sort()).toEqual(["Gone", "Kept"])
  })

  test("an edit bumps the revision and refuses a stale one with the current record", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    const edited = await presets.edit(ACTOR, {
      presetId: preset.id,
      revision: preset.revision,
      ...presetDraft({ name: "Renamed", configurations: { primary: primaryConfiguration({ effort: "high" }) } }),
    })
    expect(edited.revision).toBe(2)
    expect(edited.name).toBe("Renamed")
    expect(edited.configurations.primary.effort).toBe("high")

    const detail = await refusalOf(() =>
      presets.edit(ACTOR, { presetId: preset.id, revision: preset.revision, ...presetDraft({ name: "Later" }) }),
    )
    expect(detail.code).toBe("stale_revision")
    expect(detail.currentPreset?.revision).toBe(2)
    expect((await presets.get(ACTOR, preset.id)).name).toBe("Renamed")
  })

  test("archive and restore are one-way each and keep the revision moving", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    const archived = await presets.archive(ACTOR, { presetId: preset.id, revision: 1 })
    expect(archived.archivedAt).not.toBeNull()
    expect(archived.revision).toBe(2)

    expect((await refusalOf(() => presets.archive(ACTOR, { presetId: preset.id, revision: 2 }))).code).toBe("conflict")

    const restored = await presets.restore(ACTOR, { presetId: preset.id, revision: 2 })
    expect(restored.archivedAt).toBeNull()
    expect(restored.revision).toBe(3)
    expect((await refusalOf(() => presets.restore(ACTOR, { presetId: preset.id, revision: 3 }))).code).toBe("conflict")
  })

  test("a foreign owner cannot archive a preset", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    expect((await refusalOf(() => presets.archive(OTHER_ACTOR, { presetId: preset.id, revision: 1 }))).code).toBe("not_found")
    expect((await presets.get(ACTOR, preset.id)).archivedAt).toBeNull()
  })

  test("a caller that mutates a preset it read cannot rewrite the stored row", async () => {
    const preset = await presets.create(ACTOR, presetDraft())
    const read = await presets.get(ACTOR, preset.id)
    read.name = "Rewritten"
    read.configurations.primary.model.modelID = "rewritten"
    const reread = await presets.get(ACTOR, preset.id)
    expect(reread.name).toBe("Local preset")
    expect(reread.configurations.primary.model.modelID).toBe("claude-sonnet")
  })
})
