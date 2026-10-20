import type { SurfaceComponent } from "@claxedo/plugin-api"
import { CONFIGURATION_SLOTS, type ConfigurationSlot, type Preset, type Task } from "../../contracts"
import type { Translate } from "../dictionary"
import { SLOT_KEYS } from "../slots"
import type { Json, JsonObject } from "../surface/json"
import { bound, callout, surfaceButton, surfaceColumn, surfaceSection } from "../surface/parts"
import { PAGE_EVENTS } from "./events"
import { LIVENESS_KEYS, presetsForSlot, slotAttempt, type TaskLinkGroup } from "./model"
import { startProgressText, type StartProgress } from "./start-run"

export type SlotsView = {
  readonly t: Translate
  readonly task: Task
  readonly groups: readonly TaskLinkGroup[]
  readonly presets: readonly Preset[]
  readonly progress: StartProgress
  readonly chosen: Readonly<Partial<Record<ConfigurationSlot, string>>>
}

export function shownSlots(view: Pick<SlotsView, "groups">): readonly ConfigurationSlot[] {
  return CONFIGURATION_SLOTS.filter((slot) => slot === "primary" || view.groups.some((group) => group.slot === slot))
}

function sessionSlotNotice(view: SlotsView, slot: ConfigurationSlot): SurfaceComponent[] {
  const { t } = view
  const open = slotAttempt(view.groups, slot).open
  if (open?.handoff === "pending") {
    return [
      callout(`slot-${slot}-notice`, "warning", t("claxedo-tasks.slot.notSentTitle"), { text: t("claxedo-tasks.slot.notSentText"), action: `slot-${slot}-send` }),
      ...surfaceButton(`slot-${slot}-send`, t("claxedo-tasks.slot.send"), PAGE_EVENTS.slotSend, { icon: "send", context: { slot } }),
    ]
  }
  if (open?.handoff === "unknown") return [callout(`slot-${slot}-notice`, "info", t("claxedo-tasks.slot.unknownTitle"), { text: t("claxedo-tasks.slot.unknownText") })]
  return []
}

function slotControls(view: SlotsView, slot: ConfigurationSlot): { readonly actions: readonly string[]; readonly parts: SurfaceComponent[] } {
  const { t, task } = view
  const next = slotAttempt(view.groups, slot)
  if (next.open) return { actions: [`slot-${slot}-open`], parts: surfaceButton(`slot-${slot}-open`, t("claxedo-tasks.slot.openSession"), PAGE_EVENTS.slotOpen, { icon: "visibility", context: { slot } }) }
  const offered = presetsForSlot(view.presets, slot)
  if (offered.length === 0) return { actions: [`slot-${slot}-create-preset`], parts: surfaceButton(`slot-${slot}-create-preset`, t("claxedo-tasks.page.createPreset"), PAGE_EVENTS.openPresets, { icon: "settings" }) }
  const continuable = next.again && next.current?.liveness !== "deleted" && offered.some((preset) => preset.id === next.current?.presetId)
  const archived = task.archivedAt !== null
  const buttons = archived ? [] : [...(continuable ? [`slot-${slot}-continue`] : []), `slot-${slot}-start`]
  return {
    actions: [`slot-${slot}-preset`, ...buttons],
    parts: [
      { id: `slot-${slot}-preset`, component: "ChoicePicker", label: t("claxedo-tasks.slot.preset"), variant: "mutuallyExclusive", displayStyle: "menu", options: offered.map((preset) => ({ label: preset.name, value: preset.id, icon: "settings" as const })), value: bound(`/detail/slots/${slot}/preset`), change: { event: { name: PAGE_EVENTS.slotPreset, context: { slot } } } },
      ...surfaceButton(`slot-${slot}-start`, t(next.again ? "claxedo-tasks.slot.startAgain" : "claxedo-tasks.slot.start"), PAGE_EVENTS.slotStart, { icon: "play", context: { slot, preset: bound(`/detail/slots/${slot}/preset`) } }),
      ...(continuable ? surfaceButton(`slot-${slot}-continue`, t("claxedo-tasks.slot.continue"), PAGE_EVENTS.slotContinue, { variant: "borderless", context: { slot } }) : []),
    ],
  }
}

function slotProgress(view: SlotsView, slot: ConfigurationSlot): SurfaceComponent[] {
  const progress = view.progress
  if (progress.kind === "idle" || progress.taskId !== view.task.id || progress.slot !== slot) return []
  return [{ id: `slot-${slot}-progress`, component: "Spinner", label: startProgressText(view.t, progress) ?? "" }]
}

function slotAttempts(view: SlotsView, slot: ConfigurationSlot): SurfaceComponent[] {
  const group = view.groups.find((entry) => entry.slot === slot)
  if (!group || group.attempts.length === 0) return []
  return [
    { id: `slot-${slot}-attempts`, component: "Collapsible", title: view.t("claxedo-tasks.slot.attempts"), child: `slot-${slot}-attempt-list` },
    { id: `slot-${slot}-attempt-list`, component: "List", children: { componentId: "attempt-row", path: `/detail/slots/${slot}/attempts` } },
  ]
}

function sessionSlot(view: SlotsView, slot: ConfigurationSlot): SurfaceComponent[] {
  const { t } = view
  const current = slotAttempt(view.groups, slot).current
  const subtitle = current ? t("claxedo-tasks.slot.attempt", { attempt: current.attempt, liveness: t(LIVENESS_KEYS[current.liveness]) }) : t("claxedo-tasks.slot.noSession")
  const controls = slotControls(view, slot)
  const parts = [...sessionSlotNotice(view, slot), ...slotProgress(view, slot), ...slotAttempts(view, slot)]
  const children = [`slot-${slot}-row`, ...[`slot-${slot}-notice`, `slot-${slot}-progress`, `slot-${slot}-attempts`].filter((id) => parts.some((part) => part.id === id))]
  return [
    surfaceColumn(`slot-${slot}`, children),
    { id: `slot-${slot}-row`, component: "ListItem", title: t(SLOT_KEYS[slot]), subtitle, icon: current?.liveness === "live" ? "circleHalf" : "circle", actions: [...controls.actions] },
    ...controls.parts,
    ...parts,
  ]
}

export function sessionsComponents(view: SlotsView): SurfaceComponent[] {
  const { t } = view
  const slots = shownSlots(view)
  return [
    surfaceSection("detail-sessions", "detail-sessions-body", { title: t("claxedo-tasks.sessions.title"), actions: ["detail-presets"], plain: true }),
    ...surfaceButton("detail-presets", t("claxedo-tasks.page.presets"), PAGE_EVENTS.openPresets, { variant: "borderless", icon: "settings" }),
    surfaceColumn("detail-sessions-body", slots.map((slot) => `slot-${slot}`)),
    ...slots.flatMap((slot) => sessionSlot(view, slot)),
    { id: "attempt-row", component: "ListItem", title: bound("title"), subtitle: bound("subtitle"), meta: ["attempt-badges"], actions: ["attempt-tools"] },
    { id: "attempt-badges", component: "List", direction: "horizontal", children: { componentId: "attempt-badge", path: "badges" } },
    { id: "attempt-badge", component: "Badge", text: bound("text"), variant: bound("tone") },
    { id: "attempt-tools", component: "List", direction: "horizontal", children: { componentId: "attempt-tool", path: "tools" } },
    ...surfaceButton("attempt-tool", bound("label"), PAGE_EVENTS.attemptOpen, { icon: "visibility", context: { slot: bound("slot"), attempt: bound("attempt") } }),
  ]
}

function attemptRow(t: Translate, group: TaskLinkGroup, index: number): Json {
  const link = group.attempts[index]
  if (!link) return null
  const tone = link.liveness === "live" ? "success" : link.liveness === "deleted" ? "danger" : "neutral"
  const label = t("claxedo-tasks.slot.attemptRow", { attempt: link.attempt })
  return {
    title: label,
    subtitle: [link.presetNameAtStart, ...(link.continuedFrom ? [t("claxedo-tasks.slot.continued")] : [])].join(" · "),
    badges: [{ text: t(LIVENESS_KEYS[link.liveness]), tone }],
    tools: link.liveness === "deleted" ? [] : [{ slot: group.slot, attempt: link.attempt, label: `${t("claxedo-tasks.slot.openSession")}: ${label}` }],
  }
}

export function sessionsData(view: SlotsView): JsonObject {
  const slots: JsonObject = {}
  for (const slot of shownSlots(view)) {
    const group = view.groups.find((entry) => entry.slot === slot)
    const offered = presetsForSlot(view.presets, slot)
    const chosen = view.chosen[slot] ?? group?.current?.presetId
    const preset = offered.find((entry) => entry.id === chosen) ?? offered[0]
    slots[slot] = {
      preset: preset ? [preset.id] : [],
      attempts: group ? group.attempts.map((_, index) => attemptRow(view.t, group, index)) : [],
    }
  }
  return slots
}
