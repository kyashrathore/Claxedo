import { harnessProductLabel } from "@claxedo/agent-runtime-contract"
import type { SurfaceComponent } from "@claxedo/plugin-api"
import { CONFIGURATION_SLOTS, type ConfigurationSlot } from "../../contracts"
import type { Translate } from "../dictionary"
import { fieldReason } from "../refusal"
import { SLOT_KEYS } from "../slots"
import type { JsonObject } from "../surface/json"
import { bound, surfaceButton, callout, surfaceColumn, footer, surfaceSection } from "../surface/parts"
import { capabilityKey, type CapabilityEntry } from "./catalog"
import { clientDraftOf } from "./client-draft"
import { OPTIONAL_SLOTS, type DraftProblem } from "./draft"
import type { OpenEditor, PresetsState } from "./state"

export const EDITOR_EVENTS = {
  placement: "presetPlacementChanged",
  slots: "presetSlotsChanged",
  configured: "presetConfigured",
  capabilities: "presetCapabilitiesChanged",
  save: "savePreset",
  cancel: "cancelPreset",
} as const

const DRAFT = { draft: bound("/draft") }

function problemText(t: Translate, problem: DraftProblem): string {
  return problem.kind === "kit" ? problem.text : t(problem.key, problem.params)
}

function placementWord(t: Translate, placement: string): string {
  return t(placement === "cloud" ? "claxedo-tasks.preset.cloud" : "claxedo-tasks.preset.local")
}

function detailsNotice(t: Translate, state: PresetsState, editor: OpenEditor): SurfaceComponent[] {
  if (editor.problems.name) return [callout("details-notice", "danger", problemText(t, editor.problems.name))]
  if (state.placements.includes(editor.draft.placement)) return []
  const placement = placementWord(t, editor.draft.placement)
  return [callout("details-notice", "warning", t("claxedo-tasks.preset.unsupportedPlacementTitle", { placement }), { text: t("claxedo-tasks.preset.unsupportedPlacement") })]
}

function detailsSection(t: Translate, state: PresetsState, editor: OpenEditor): SurfaceComponent[] {
  const notice = detailsNotice(t, state, editor)
  const options = [{ label: t("claxedo-tasks.preset.local"), value: "local" }, { label: t("claxedo-tasks.preset.cloud"), value: "cloud" }]
  return [
    surfaceSection("editor-details", "details-body", { title: t("claxedo-tasks.preset.details") }),
    surfaceColumn("details-body", [...notice.map((entry) => entry.id), "details-grid", "draft-instructions", "draft-agents", "draft-agents-hint"]),
    ...notice,
    { id: "details-grid", component: "Grid", columns: 2, children: ["draft-name", "draft-placement"] },
    { id: "draft-name", component: "TextField", label: t("claxedo-tasks.preset.name"), value: bound("/draft/name") },
    { id: "draft-placement", component: "ChoicePicker", label: t("claxedo-tasks.preset.placement"), variant: "mutuallyExclusive", displayStyle: "chips", options, value: bound("/draft/placement"), change: { event: { name: EDITOR_EVENTS.placement, context: DRAFT } } },
    { id: "draft-instructions", component: "TextField", label: t("claxedo-tasks.preset.instructions"), variant: "longText", value: bound("/draft/instructions") },
    { id: "draft-agents", component: "Switch", label: t("claxedo-tasks.preset.agentStartable"), value: bound("/draft/agentStartable") },
    { id: "draft-agents-hint", component: "Text", variant: "caption", text: t("claxedo-tasks.preset.agentStartableHint") },
  ]
}

function slotNotice(t: Translate, editor: OpenEditor, slot: ConfigurationSlot): SurfaceComponent[] {
  const problem = editor.problems[slot]
  if (!problem) return []
  if (problem.kind === "words") return [callout(`slot-${slot}-notice`, "danger", problemText(t, problem))]
  const harnessId = editor.draft.configurations[slot]?.harness?.id ?? ""
  const harness = harnessProductLabel(harnessId) ?? harnessId
  return [callout(`slot-${slot}-notice`, "danger", t("claxedo-tasks.preset.cloudHarnessTitle", { harness }), { text: problem.text })]
}

function slotSection(t: Translate, editor: OpenEditor, slot: ConfigurationSlot): SurfaceComponent[] {
  const notice = slotNotice(t, editor, slot)
  return [
    surfaceSection(`slot-${slot}`, `slot-${slot}-body`, { title: t(SLOT_KEYS[slot]), plain: true }),
    surfaceColumn(`slot-${slot}-body`, [...notice.map((entry) => entry.id), `slot-${slot}-picker`]),
    ...notice,
    {
      id: `slot-${slot}-picker`,
      component: "AgentConfigurationPicker",
      placement: editor.draft.placement,
      value: bound(`/draft/configurations/${slot}`),
      disabled: editor.saving,
      change: { event: { name: EDITOR_EVENTS.configured, context: { ...DRAFT, slot } } },
    },
  ]
}

function configurationsSection(t: Translate, editor: OpenEditor): SurfaceComponent[] {
  const slots = CONFIGURATION_SLOTS.filter((slot) => editor.draft.configurations[slot] !== null)
  const options = OPTIONAL_SLOTS.map((slot) => ({ label: t(SLOT_KEYS[slot]), value: slot }))
  return [
    surfaceSection("editor-configurations", "configurations-body", { title: t("claxedo-tasks.preset.configurations"), description: t("claxedo-tasks.preset.configurationsHint") }),
    surfaceColumn("configurations-body", ["slot-primary", "draft-slots", ...slots.filter((slot) => slot !== "primary").map((slot) => `slot-${slot}`)]),
    { id: "draft-slots", component: "ChoicePicker", label: t("claxedo-tasks.preset.moreSlots"), variant: "multipleSelection", displayStyle: "chips", options, value: bound("/draft/slots"), change: { event: { name: EDITOR_EVENTS.slots, context: DRAFT } } },
    ...slots.flatMap((slot) => slotSection(t, editor, slot)),
  ]
}

function capabilityOptions(t: Translate, entries: readonly CapabilityEntry[], chosen: readonly string[]) {
  return entries
    .filter((entry) => entry.availability === "ready" || chosen.includes(capabilityKey(entry.selection)))
    .map((entry) => {
      const description = entry.availability === "ready"
        ? (entry.bundledSkills.length > 0 ? t("claxedo-tasks.preset.bundledSkills", { skills: entry.bundledSkills.join(", ") }) : entry.description)
        : t(entry.availability === "unretained" ? "claxedo-tasks.preset.turnOnFirst" : "claxedo-tasks.preset.unavailable")
      return { label: entry.selection.name, value: capabilityKey(entry.selection), ...(description ? { description } : {}) }
    })
}

function capabilityPicker(t: Translate, state: PresetsState, kind: "plugins" | "skills"): SurfaceComponent {
  const empty = state.catalog.kind === "failed" ? t("claxedo-tasks.preset.catalogFailed") : t(kind === "plugins" ? "claxedo-tasks.preset.noPlugins" : "claxedo-tasks.preset.noSkills")
  return {
    id: `draft-${kind}`,
    component: "Combobox",
    label: t(kind === "plugins" ? "claxedo-tasks.preset.plugins" : "claxedo-tasks.preset.skills"),
    multiple: true,
    value: bound(`/draft/${kind}`),
    options: bound(`/options/${kind}`),
    placeholder: t(kind === "plugins" ? "claxedo-tasks.preset.pickPlugins" : "claxedo-tasks.preset.pickSkills"),
    emptyText: empty,
    change: { event: { name: EDITOR_EVENTS.capabilities, context: DRAFT } },
  }
}

function capabilityPickers(t: Translate, state: PresetsState): SurfaceComponent[] {
  return [
    { id: "capabilities-grid", component: "Grid", columns: 2, children: ["draft-plugins", "draft-skills"] },
    capabilityPicker(t, state, "plugins"),
    capabilityPicker(t, state, "skills"),
  ]
}

function capabilitiesSection(t: Translate, state: PresetsState, editor: OpenEditor): SurfaceComponent[] {
  const cloud = editor.draft.placement === "cloud"
  const guarantee = cloud
    ? callout("capabilities-guarantee", "info", t("claxedo-tasks.preset.guaranteeCloudTitle"), { text: t("claxedo-tasks.preset.guaranteeCloud") })
    : callout("capabilities-guarantee", "info", t("claxedo-tasks.preset.guaranteeLocalTitle"), { text: t("claxedo-tasks.preset.guaranteeLocal") })
  return [
    surfaceSection("editor-capabilities", "capabilities-body", { title: t("claxedo-tasks.preset.capabilities") }),
    surfaceColumn("capabilities-body", cloud ? ["capabilities-guarantee", "capabilities-grid"] : ["capabilities-guarantee"]),
    guarantee,
    ...(cloud ? capabilityPickers(t, state) : []),
  ]
}

function refusalText(t: Translate, editor: OpenEditor): string | undefined {
  const fields = Object.entries(editor.refusal?.fields ?? {})
  return fields.length === 0 ? undefined : fields.map(([path, reason]) => t("claxedo-tasks.preset.fieldRefused", { field: path, reason: fieldReason(t, reason) })).join("; ")
}

function closingParts(t: Translate, editor: OpenEditor): SurfaceComponent[] {
  const saveLabel = t(editor.target ? "claxedo-tasks.preset.save" : "claxedo-tasks.preset.create")
  const reasons = refusalText(t, editor)
  const problem = editor.refusal ? [callout("editor-problem", "danger", editor.refusal.message, reasons ? { text: reasons } : {})] : []
  const end = editor.saving ? [{ id: "editor-saving", component: "Spinner", label: t("claxedo-tasks.preset.saving") } as const] : surfaceButton("editor-save", saveLabel, EDITOR_EVENTS.save, { variant: "primary", context: DRAFT })
  return [
    ...problem,
    footer("editor-footer", [end[0]?.id ?? "editor-save"], ["editor-cancel"]),
    ...end,
    ...surfaceButton("editor-cancel", t("claxedo-tasks.preset.cancel"), EDITOR_EVENTS.cancel, { variant: "borderless" }),
  ]
}

function editorHeader(t: Translate, editor: OpenEditor): SurfaceComponent {
  const slots = CONFIGURATION_SLOTS.filter((slot) => editor.draft.configurations[slot] !== null).map((slot) => t(SLOT_KEYS[slot]))
  const subtitle = t("claxedo-tasks.preset.editSubtitle", { placement: placementWord(t, editor.draft.placement), slots: slots.join(", ") })
  return { id: "editor-header", component: "Header", title: editor.target?.name ?? t("claxedo-tasks.preset.newTitle"), subtitle, icon: "settings" }
}

export function presetEditorComponents(t: Translate, state: PresetsState, editor: OpenEditor): SurfaceComponent[] {
  const notice = editor.changedElsewhere ? [callout("editor-notice", "warning", t("claxedo-tasks.preset.changedElsewhere"))] : []
  const closing = closingParts(t, editor)
  return [
    surfaceColumn("root", ["editor-header", ...notice.map((entry) => entry.id), "editor-details", "editor-configurations", "editor-capabilities", ...(editor.refusal ? ["editor-problem"] : []), "editor-footer"]),
    editorHeader(t, editor),
    ...notice,
    ...detailsSection(t, state, editor),
    ...configurationsSection(t, editor),
    ...capabilitiesSection(t, state, editor),
    ...closing,
  ]
}

export function presetEditorData(t: Translate, state: PresetsState, editor: OpenEditor): JsonObject {
  const catalog = state.catalog.kind === "ready" ? state.catalog.catalog : { plugins: [], skills: [] }
  const draft = clientDraftOf(editor.draft)
  const chosen = (kind: "plugins" | "skills") => editor.draft[kind].map(capabilityKey)
  return {
    draft,
    options: { plugins: capabilityOptions(t, catalog.plugins, chosen("plugins")), skills: capabilityOptions(t, catalog.skills, chosen("skills")) },
  }
}
