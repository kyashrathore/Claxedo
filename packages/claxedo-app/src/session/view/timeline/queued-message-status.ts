import type { QueuedMessage, TimelineTranslate } from "./model"

export type QueuedMessageStatus = { readonly label: string; readonly reason?: string; readonly send: string }

export function queuedMessageStatus(item: QueuedMessage, editing: boolean, t: TimelineTranslate): QueuedMessageStatus {
  const state = item.steering?.state
  if (state === "rejected") {
    return { label: t("ui.message.queued.declined"), ...(item.steering?.message ? { reason: item.steering.message } : {}), send: t("ui.message.queued.retry") }
  }
  const label = state === "accepted" ? t("ui.message.queued.accepted")
    : state === "dispatching" ? t("ui.message.queued.dispatching")
    : state === "unknown" ? t("ui.message.queued.unknown")
    : t(editing ? "ui.message.queued.editing" : "ui.message.queued")
  return { label, send: t("ui.message.queued.sendNow") }
}
