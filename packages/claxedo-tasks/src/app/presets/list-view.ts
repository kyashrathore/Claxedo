import { harnessProductLabel } from "@claxedo/agent-runtime-contract"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { CONFIGURATION_SLOTS, type Preset } from "../../contracts"
import { shortAgeText } from "../age"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, surfaceButton, callout, surfaceColumn, surfaceSection } from "../surface/parts"
import { SLOT_KEYS } from "../slots"
import type { PresetsState } from "./state"

export const PRESET_EVENTS = {
  create: "createPreset",
  edit: "editPreset",
  toggle: "togglePresetArchive",
  showArchived: "showArchivedPresets",
  retry: "retryPresets",
} as const

function presetSummary(t: Translate, preset: Preset, now: number): string {
  const primary = preset.configurations.primary
  return [
    t(preset.execution.placement === "cloud" ? "claxedo-tasks.preset.cloud" : "claxedo-tasks.preset.local"),
    harnessProductLabel(primary.harness.id) ?? primary.harness.id,
    primary.model.modelID,
    ...(primary.effort ? [primary.effort] : []),
    t("claxedo-tasks.preset.updated", { age: shortAgeText(t, preset.updatedAt, now) }),
  ].join(" · ")
}

function presetBadges(t: Translate, preset: Preset): Json[] {
  const slots = CONFIGURATION_SLOTS.filter((slot) => slot !== "primary" && preset.configurations[slot]).map((slot) => t(SLOT_KEYS[slot]))
  return [
    ...(preset.archivedAt === null ? [] : [{ text: t("claxedo-tasks.preset.archived"), tone: "warning" }]),
    ...(slots.length > 0 ? [{ text: t("claxedo-tasks.preset.alsoSlots", { slots: slots.join(", ") }), tone: "neutral" }] : []),
    ...(preset.agentStartable ? [{ text: t("claxedo-tasks.preset.agentStartableBadge"), tone: "accent" }] : []),
  ]
}

function presetRow(t: Translate, preset: Preset, now: number): JsonObject {
  const archived = preset.archivedAt !== null
  return {
    id: preset.id,
    name: preset.name,
    summary: presetSummary(t, preset, now),
    badges: presetBadges(t, preset),
    toggleLabel: t(archived ? "claxedo-tasks.preset.restore" : "claxedo-tasks.preset.archive", { name: preset.name }),
    toggleIcon: archived ? "visibility" : "visibilityOff",
  }
}

const ROW_COMPONENTS: SurfaceComponent[] = [
  { id: "preset-row", component: "ListItem", title: bound("name"), subtitle: bound("summary"), meta: ["preset-badges"], primaryAction: "preset-edit", actions: ["preset-toggle"] },
  { id: "preset-badges", component: "List", direction: "horizontal", children: { componentId: "preset-badge", path: "badges" } },
  { id: "preset-badge", component: "Badge", text: bound("text"), variant: bound("tone") },
]

function rowButtons(t: Translate): SurfaceComponent[] {
  return [
    ...surfaceButton("preset-edit", t("claxedo-tasks.preset.edit"), PRESET_EVENTS.edit, { context: { presetId: bound("id") } }),
    ...surfaceButton("preset-toggle", bound("toggleLabel"), PRESET_EVENTS.toggle, { icon: bound("toggleIcon"), context: { presetId: bound("id") } }),
  ]
}

function listBody(t: Translate, state: PresetsState): SurfaceComponent[] {
  const list = state.list
  if (list.kind === "loading") return [{ id: "presets-content", component: "Spinner", label: t("claxedo-tasks.preset.loading") }]
  if (list.kind === "failed") {
    return [
      callout("presets-content", "danger", t("claxedo-tasks.preset.loadFailed"), { text: list.message, action: "presets-retry" }),
      ...surfaceButton("presets-retry", t("claxedo-tasks.preset.retry"), PRESET_EVENTS.retry, { icon: "refresh" }),
    ]
  }
  if (list.presets.length === 0) {
    return [{ id: "presets-content", component: "EmptyState", title: t("claxedo-tasks.preset.emptyTitle"), description: t("claxedo-tasks.preset.emptyText") }]
  }
  return [{ id: "presets-content", component: "List", children: { componentId: "preset-row", path: "/presets" } }, ...ROW_COMPONENTS, ...rowButtons(t)]
}

export function presetListComponents(t: Translate, state: PresetsState): SurfaceComponent[] {
  return [
    surfaceColumn("root", ["presets"]),
    surfaceSection("presets", "presets-body", { title: t("claxedo-tasks.preset.listTitle"), description: t("claxedo-tasks.preset.listDescription"), actions: ["presets-new"] }),
    ...surfaceButton("presets-new", t("claxedo-tasks.preset.new"), PRESET_EVENTS.create, { icon: "add" }),
    surfaceColumn("presets-body", ["presets-content", "presets-archived"]),
    { id: "presets-archived", component: "Switch", label: t("claxedo-tasks.preset.showArchived"), value: bound("/showArchived"), change: { event: { name: PRESET_EVENTS.showArchived } } },
    ...listBody(t, state),
  ]
}

export function presetListData(t: Translate, state: PresetsState, now: number): JsonObject {
  return {
    showArchived: state.showArchived,
    presets: state.list.kind === "ready" ? state.list.presets.map((preset) => presetRow(t, preset, now)) : [],
  }
}
