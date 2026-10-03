import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { SessionRowView } from "@/session"
import { ClaxedoIcon } from "@/ui"
import { railDictionary, type RailKey } from "../i18n"
import { navigationStatus, type NavigationStatus } from "../model"
import { NavigationStatusMark } from "./navigation-row"

const STATUS_LABELS: Readonly<Record<Exclude<NavigationStatus, "idle">, RailKey>> = { working: "rail.card.working", background: "rail.card.background", permission: "rail.card.waiting", error: "rail.resultUnseenFailed", interrupted: "rail.card.interrupted", done: "rail.resultUnseen" }

export function ActivityStatusMark(props: { readonly row: SessionRowView }): JSX.Element {
  const t = useTranslator(railDictionary)
  const status = () => navigationStatus(props.row)
  const unavailable = () => props.row.executionAvailability?.status !== "available" || (props.row.status.kind === "unknown" && !props.row.attention)
  const label = () => {
    const current = status()
    return unavailable() ? t("rail.statusUnavailable") : current === "idle" ? "" : t(STATUS_LABELS[current])
  }
  const reason = () => { const availability = props.row.executionAvailability; return availability && "message" in availability ? availability.message : undefined }
  return <Show when={unavailable() || status() !== "idle"}><span role="img" aria-label={label()} aria-description={reason()} title={reason() ?? label()} class="flex size-4 shrink-0 items-center justify-center"><Show when={!unavailable()} fallback={<ClaxedoIcon name="circle-alert" size="small" />}><NavigationStatusMark status={status()} /></Show></span></Show>
}
