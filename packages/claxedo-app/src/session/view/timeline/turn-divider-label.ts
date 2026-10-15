import { formatDuration } from "@/transcript"
import type { TimelineTranslate } from "./model"
import type { TimelineRow } from "./timeline-row-model"

export function turnDividerLabel(divider: TimelineRow.TurnDivider, t: TimelineTranslate): string {
  if (divider.label === "worked") return t("ui.message.workedDuration", { duration: formatDuration(divider.durationMs) })
  if (divider.label === "compaction") return t("ui.messagePart.compaction")
  if (divider.label === "handoff") return `Session handed off to ${divider.harness}`
  return typeof divider.durationMs === "number"
    ? t("ui.message.interruptedDuration", { duration: formatDuration(divider.durationMs) })
    : t("ui.message.interrupted")
}
