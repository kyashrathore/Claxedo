import { describe, expect, test } from "bun:test"
import type { PluginApi, Toast } from "@claxedo/plugin-api"
import { englishWords, reachableIds, recordedSurface, actionsSettled, surfaceAction, tasksServer, type RecordedSurface } from "../test-host"
import type { Json } from "../surface/json"
import { capabilityCatalogOf } from "./catalog"
import { tasksClientOf } from "../tasks-client"
import { openPresetsSettings } from "./program"

const CLAUDE = { harness: { id: "claude", access: "native" }, model: { providerID: "anthropic", modelID: "claude-opus-4-8" }, effort: "high" }
const PI = { harness: { id: "pi", access: "native" }, model: { providerID: "openai", modelID: "gpt-5" }, effort: null }

const CATALOG = {
  candidates: [
    { sourceId: "github:acme/tools", sourceAvailable: true, retainedDigest: "sha256:deploy", manifest: { name: "deploy", description: "Ship builds" }, skills: [{ name: "release-notes", description: "Write release notes" }] },
    { sourceId: "local", sourceAvailable: false, manifest: { name: "gone" }, skills: [] },
    { sourceId: "claxedo", sourceAvailable: true, retainedDigest: null, manifest: { name: "composio", description: "Connect apps" }, skills: [] },
  ],
}

function open() {
  const server = tasksServer()
  const surface = recordedSurface()
  const toasts: Toast[] = []
  const ui = { toast: (toast: Toast) => void toasts.push(toast), confirm: async () => true } satisfies PluginApi["ui"]
  let ids = 0
  const program = openPresetsSettings(
    { client: server.client, t: englishWords, ui, catalog: async () => capabilityCatalogOf(CATALOG), requestId: () => `request-${(ids += 1)}`, now: () => 10_000 },
    surface,
  )
  const fire = async (name: string, context: Record<string, Json | undefined> = {}) => {
    await program.action?.(surfaceAction(name, context))
    await actionsSettled()
  }
  return { server, surface, toasts, program, fire }
}

function visibleTexts(surface: RecordedSurface): string {
  return JSON.stringify([...reachableIds(surface)].map((id) => surface.component(id)))
}

async function fillAndSave(surface: RecordedSurface, fire: (name: string, context?: Record<string, Json | undefined>) => Promise<void>, configuration: Json, name = "Careful reviewer") {
  surface.write("/draft/name", name)
  surface.write("/draft/configurations/primary", configuration)
  await fire("presetConfigured", { draft: surface.read("/draft"), slot: "primary", value: configuration })
  await fire("savePreset", { draft: surface.read("/draft") })
}

describe("Settings → Presets as a surface", () => {
  test("opens on an empty list that says what to do, with every component reachable and valid", async () => {
    const { surface } = open()
    await actionsSettled()
    expect(surface.check()).toMatchObject({ ok: true })
    expect(surface.component("presets-content")).toMatchObject({ component: "EmptyState", title: "No presets yet" })
    expect(surface.component("presets")).toMatchObject({ component: "Section", title: "Your presets", actions: ["presets-new"] })
  })

  test("a capabilities answer that lands after the list keeps the list it loaded", async () => {
    const server = tasksServer()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const slowCapabilities = {
      ...server.server,
      fetch: async (path: string, init?: RequestInit) => {
        if (path.endsWith("/capabilities")) await held
        return server.server.fetch(path, init)
      },
    }
    const surface = recordedSurface()
    const ui = { toast: () => undefined, confirm: async () => true }
    openPresetsSettings({ client: tasksClientOf(slowCapabilities), t: englishWords, ui, catalog: async () => capabilityCatalogOf({}), requestId: () => "request", now: () => 0 }, surface)
    await actionsSettled()
    expect(surface.component("presets-content")).toMatchObject({ component: "EmptyState" })
    release()
    await actionsSettled()
    expect(surface.component("presets-content")).toMatchObject({ component: "EmptyState" })
  })

  test("creates a local preset from the picker's configuration and lists it as the server saved it", async () => {
    const { surface, fire, server, toasts } = open()
    await actionsSettled()
    await fire("createPreset")
    expect(surface.component("slot-primary-picker")).toMatchObject({ component: "AgentConfigurationPicker", placement: "local", value: { path: "/draft/configurations/primary" } })
    expect(surface.component("editor-save")).toMatchObject({ variant: "primary" })
    await fillAndSave(surface, fire, CLAUDE)
    const saved = await server.client.listPresets()
    expect(saved.items).toMatchObject([{ name: "Careful reviewer", execution: { placement: "local" }, configurations: { primary: CLAUDE } }])
    expect(toasts).toEqual([{ kind: "success", title: "Preset created" }])
    expect(surface.read("/presets")).toMatchObject([{ name: "Careful reviewer", summary: "Local · Claude Code · claude-opus-4-8 · high · updated just now" }])
    expect(surface.read("/draft")).toBeUndefined()
    expect(surface.check()).toMatchObject({ ok: true })
  })

  test("refuses to save without a harness, naming the problem in the slot it concerns", async () => {
    const { surface, fire, server } = open()
    await actionsSettled()
    await fire("createPreset")
    surface.write("/draft/name", "Empty")
    await fire("savePreset", { draft: surface.read("/draft") })
    expect(surface.component("slot-primary-notice")).toMatchObject({ component: "Callout", tone: "danger", title: "Choose a harness" })
    expect(reachableIds(surface).has("slot-primary-notice")).toBe(true)
    expect((await server.client.listPresets()).items).toEqual([])
  })

  test("a cloud preset refuses Pi with the kit's own reason before it is saved", async () => {
    const { surface, fire } = open()
    await actionsSettled()
    await fire("createPreset")
    surface.write("/draft/placement", ["cloud"])
    await fire("presetPlacementChanged", { draft: surface.read("/draft"), value: ["cloud"] })
    surface.write("/draft/configurations/primary", PI)
    await fire("presetConfigured", { draft: surface.read("/draft"), slot: "primary", value: PI })
    expect(surface.component("slot-primary-notice")).toMatchObject({ tone: "danger", title: "Pi cannot run a cloud preset" })
    expect(visibleTexts(surface)).toContain("runs in its own session host on a cloud workspace")
    expect(surface.component("slot-primary-picker")).toMatchObject({ placement: "cloud" })
    expect(surface.read("/options/plugins")).toEqual([{ label: "deploy", value: "github:acme/tools/deploy", description: "Bundles release-notes" }])
  })

  test("offers only plugins turned on for the person, and names the fix on one a preset already chose", async () => {
    const { surface, fire } = open()
    await actionsSettled()
    await fire("createPreset")
    surface.write("/draft/placement", ["cloud"])
    await fire("presetPlacementChanged", { draft: surface.read("/draft"), value: ["cloud"] })
    expect(surface.read("/options/plugins")).toEqual([{ label: "deploy", value: "github:acme/tools/deploy", description: "Bundles release-notes" }])

    surface.write("/draft/plugins", ["claxedo/composio"])
    await fire("presetCapabilitiesChanged", { draft: surface.read("/draft") })

    expect(surface.read("/options/plugins")).toEqual([
      { label: "deploy", value: "github:acme/tools/deploy", description: "Bundles release-notes" },
      { label: "composio", value: "claxedo/composio", description: "Turn it on in Plugins first" },
    ])
  })

  test("keeps the typed name when another control redraws the editor", async () => {
    const { surface, fire } = open()
    await actionsSettled()
    await fire("createPreset")
    surface.write("/draft/name", "Typed but unsaved")
    const before = surface.messages.length
    surface.write("/draft/slots", ["review"])
    await fire("presetSlotsChanged", { draft: surface.read("/draft"), value: ["review"] })
    const patches = surface.messages.slice(before).flatMap((message) => ("updateDataModel" in message ? [message.updateDataModel.path] : []))
    expect(patches).not.toContain("/draft/name")
    expect(surface.read("/draft/name")).toBe("Typed but unsaved")
    expect(surface.read("/draft/configurations/review")).toEqual({ harness: null, model: null, effort: null })
    expect(reachableIds(surface).has("slot-review-picker")).toBe(true)
  })

  test("archives and restores a preset from its row, and the switch lists archived ones", async () => {
    const { surface, fire, server } = open()
    await actionsSettled()
    await fire("createPreset")
    await fillAndSave(surface, fire, CLAUDE, "Short-lived")
    const [preset] = (await server.client.listPresets()).items
    await fire("togglePresetArchive", { presetId: preset?.id })
    expect(surface.read("/presets")).toEqual([])
    surface.write("/showArchived", true)
    await fire("showArchivedPresets", { value: true })
    expect(surface.read("/presets")).toMatchObject([{ name: "Short-lived", toggleIcon: "visibility", toggleLabel: "Restore Short-lived", badges: [{ text: "Archived" }] }])
    await fire("togglePresetArchive", { presetId: preset?.id })
    expect(surface.read("/presets")).toMatchObject([{ name: "Short-lived", toggleIcon: "visibilityOff", badges: [] }])
  })

  test("an edit refused for a stale revision keeps the edits and asks to save again", async () => {
    const { surface, fire, server } = open()
    await actionsSettled()
    await fire("createPreset")
    await fillAndSave(surface, fire, CLAUDE, "Original")
    const [preset] = (await server.client.listPresets()).items
    if (!preset) throw new Error("no preset was saved")
    await fire("editPreset", { presetId: preset.id })
    const { id: _, revision: __, scopeId: ___, ownerId: ____, createdAt: _____, updatedAt: ______, archivedAt: _______, ...draft } = preset
    await server.client.command({ clientRequestId: "elsewhere", command: { type: "preset.edit", input: { ...draft, name: "Renamed elsewhere", presetId: preset.id, revision: preset.revision } } })
    surface.write("/draft/name", "Mine")
    await fire("savePreset", { draft: surface.read("/draft") })
    expect(surface.component("editor-notice")).toMatchObject({ tone: "warning", title: "This preset changed elsewhere. Save again to apply your edits on top." })
    expect(surface.read("/draft/name")).toBe("Mine")
    await fire("savePreset", { draft: surface.read("/draft") })
    expect((await server.client.listPresets()).items).toMatchObject([{ name: "Mine" }])
  })
})
