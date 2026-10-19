import type { PluginApi, SurfaceActionEvent, SurfaceChannel, SurfaceProgram } from "@claxedo/plugin-api"
import type { TasksClient } from "../../client/client"
import type { TasksCommand } from "../../contracts"
import type { Translate } from "../dictionary"
import { allPresets } from "../paging"
import { tasksRefusalOf } from "../refusal"
import type { Json } from "../surface/json"
import { createSurfaceSync, type SurfaceSync } from "../surface/sync"
import { capabilityCatalogOf, PLUGIN_CATALOG_PATH, type CapabilityCatalog } from "./catalog"
import { emptyPresetDraft, presetDraftInput, presetDraftOf } from "./draft"
import { editedEditor, hasProblems } from "./editor-actions"
import { EDITOR_EVENTS, presetEditorComponents, presetEditorData } from "./editor-view"
import { PRESET_EVENTS, presetListComponents, presetListData } from "./list-view"
import { INITIAL_PRESETS_STATE, openEditor, type OpenEditor, type PresetsState } from "./state"

export type PresetsDeps = {
  readonly client: TasksClient
  readonly t: Translate
  readonly ui: PluginApi["ui"]
  readonly catalog: () => Promise<CapabilityCatalog>
  readonly requestId: () => string
  readonly now: () => number
}

export function pluginCatalogReader(api: PluginApi): () => Promise<CapabilityCatalog> {
  return async () => {
    const response = await api.server.fetch(PLUGIN_CATALOG_PATH)
    if (!response.ok) throw new Error(`The plugin catalog answered ${response.status}`)
    return capabilityCatalogOf(await response.json())
  }
}

function contextString(action: SurfaceActionEvent, key: string): string | undefined {
  const value = action.context[key]
  return typeof value === "string" ? value : undefined
}

type Presets = {
  readonly state: () => PresetsState
  readonly patch: (change: Partial<PresetsState>) => void
  readonly sync: SurfaceSync
  readonly deps: PresetsDeps
}

function createLoads(model: Presets) {
  const { deps } = model
  let generation = 0
  const reload = async () => {
    const current = ++generation
    const showArchived = model.state().showArchived
    try {
      const presets = await allPresets(deps.client, showArchived)
      if (current === generation) model.patch({ list: { kind: "ready", presets } })
    } catch (error) {
      if (current === generation) model.patch({ list: { kind: "failed", message: tasksRefusalOf(error, deps.t).message } })
    }
  }
  const placements = async () => {
    try {
      const { placements } = await deps.client.capabilities()
      model.patch({ placements })
    } catch (error) {
      console.warn("The Tasks capabilities did not load", error)
    }
  }
  const catalog = async () => {
    if (model.state().catalog.kind !== "idle") return
    model.patch({ catalog: { kind: "loading" } })
    try {
      const catalog = await deps.catalog()
      model.patch({ catalog: { kind: "ready", catalog } })
    } catch (error) {
      console.warn("The plugin catalog did not load for the preset editor", error)
      model.patch({ catalog: { kind: "failed" } })
    }
  }
  return { reload, placements, catalog }
}

function editorOf(state: PresetsState): OpenEditor | undefined {
  return state.editor.kind === "open" ? state.editor : undefined
}

function createSave(model: Presets, loads: ReturnType<typeof createLoads>) {
  const { deps } = model
  const finish = (editor: OpenEditor) => {
    model.patch({ editor: { kind: "closed" } })
    deps.ui.toast({ kind: "success", title: deps.t(editor.target ? "claxedo-tasks.preset.saved" : "claxedo-tasks.preset.created") })
    void loads.reload()
  }
  const refuse = (editor: OpenEditor, error: unknown) => {
    const refusal = tasksRefusalOf(error, deps.t)
    const stale = refusal.stale?.preset
    const target = stale && editor.target ? { ...editor.target, revision: stale.revision } : editor.target
    model.patch({ editor: { ...editor, ...(target ? { target } : {}), saving: false, changedElsewhere: stale !== undefined, ...(stale ? {} : { refusal }) } })
  }
  return async (editor: OpenEditor) => {
    const input = presetDraftInput(editor.draft)
    if (!input) return
    model.patch({ editor: { ...editor, saving: true, changedElsewhere: false } })
    const command: TasksCommand = editor.target
      ? { type: "preset.edit", input: { ...input, presetId: editor.target.presetId, revision: editor.target.revision } }
      : { type: "preset.create", input }
    try {
      await deps.client.command({ clientRequestId: deps.requestId(), command })
      finish(editor)
    } catch (error) {
      refuse(editor, error)
    }
  }
}

function createToggle(model: Presets, loads: ReturnType<typeof createLoads>) {
  const { deps } = model
  return async (presetId: string) => {
    const state = model.state()
    const preset = state.list.kind === "ready" ? state.list.presets.find((entry) => entry.id === presetId) : undefined
    if (!preset || state.busyPresetId) return
    model.patch({ busyPresetId: presetId })
    const type = preset.archivedAt === null ? "preset.archive" : "preset.restore"
    try {
      await deps.client.command({ clientRequestId: deps.requestId(), command: { type, input: { presetId, revision: preset.revision } } })
    } catch (error) {
      deps.ui.toast({ kind: "error", title: deps.t("claxedo-tasks.preset.refused"), description: tasksRefusalOf(error, deps.t).message })
    }
    model.patch({ busyPresetId: undefined })
    await loads.reload()
  }
}

function editorAction(model: Presets, save: (editor: OpenEditor) => Promise<void>, action: SurfaceActionEvent): boolean {
  const editor = editorOf(model.state())
  if (!editor || editor.saving) return false
  const draftValue = action.context.draft as Json | undefined
  if (draftValue !== undefined) model.sync.observe("/draft", draftValue)
  if (action.name === EDITOR_EVENTS.cancel) {
    model.patch({ editor: { kind: "closed" } })
    return true
  }
  const edited = editedEditor(action.name === EDITOR_EVENTS.save ? { ...editor, attempted: true } : editor, draftValue)
  model.patch({ editor: edited })
  if (action.name === EDITOR_EVENTS.save && !hasProblems(edited)) void save(edited)
  return true
}

function listAction(model: Presets, loads: ReturnType<typeof createLoads>, toggle: (presetId: string) => Promise<void>, action: SurfaceActionEvent) {
  const state = model.state()
  const presetId = contextString(action, "presetId")
  if (action.name === PRESET_EVENTS.create) {
    model.patch({ editor: openEditor(emptyPresetDraft()) })
    void loads.catalog()
  } else if (action.name === PRESET_EVENTS.edit && presetId) {
    const preset = state.list.kind === "ready" ? state.list.presets.find((entry) => entry.id === presetId) : undefined
    if (preset) model.patch({ editor: openEditor(presetDraftOf(preset), { presetId: preset.id, revision: preset.revision, name: preset.name }) })
    void loads.catalog()
  } else if (action.name === PRESET_EVENTS.toggle && presetId) {
    void toggle(presetId)
  } else if (action.name === PRESET_EVENTS.showArchived) {
    model.sync.observe("/showArchived", action.context.value === true)
    model.patch({ showArchived: action.context.value === true, list: { kind: "loading" } })
    void loads.reload()
  } else if (action.name === PRESET_EVENTS.retry) {
    model.patch({ list: { kind: "loading" } })
    void loads.reload()
  }
}

function presetsFrame(deps: PresetsDeps, state: PresetsState) {
  const editor = editorOf(state)
  if (editor) return { components: presetEditorComponents(deps.t, state, editor), data: presetEditorData(deps.t, state, editor) }
  return { components: presetListComponents(deps.t, state), data: presetListData(deps.t, state, deps.now()) }
}

export function openPresetsSettings(deps: PresetsDeps, channel: SurfaceChannel): SurfaceProgram {
  const sync = createSurfaceSync(channel)
  let state = INITIAL_PRESETS_STATE
  let open = true
  const model: Presets = {
    state: () => state,
    patch: (change) => {
      state = { ...state, ...change }
      if (open) sync.draw(presetsFrame(deps, state))
    },
    sync,
    deps,
  }
  const loads = createLoads(model)
  const save = createSave(model, loads)
  const toggle = createToggle(model, loads)
  model.patch({})
  void loads.reload()
  void loads.placements()
  return {
    action: (action) => {
      if (!editorAction(model, save, action)) listAction(model, loads, toggle, action)
    },
    dispose: () => {
      open = false
    },
  }
}
