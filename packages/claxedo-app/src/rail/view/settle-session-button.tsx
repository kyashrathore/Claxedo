import { createMemo, createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { sessionAttention } from "@/server"
import type { SessionRowView } from "@/session"
import { ClaxedoIcon, Tooltip } from "@/ui"
import { railDictionary } from "../i18n"
import type { SessionRowMenuActions } from "./session-row-menu"

export function SettleSessionButton(props: Pick<SessionRowMenuActions, "onToggleSettled"> & { readonly row: SessionRowView; readonly compact?: boolean }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [busy, setBusy] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const settled = createMemo(() => !!props.row.attention && sessionAttention(props.row.attention, props.row.reader).settled)
  const disabled = () => busy() || !props.row.attention || (!settled() && (props.row.executionAvailability?.status !== "available" || props.row.attention.working || props.row.attention.awaitingInput))
  const label = () => t(settled() ? "rail.returnActive" : "rail.settleSession", { title: props.row.title })
  const toggle = async (event: MouseEvent) => {
    event.stopPropagation()
    setBusy(true)
    try { await props.onToggleSettled(props.row) } finally { setBusy(false) }
  }
  return (
    <Tooltip value={t(settled() ? "rail.returnToActive" : "rail.settle")} forceOpen={focused()} contentClass="ui-session-tooltip">
      <button type="button" data-slot="session-settle" aria-label={label()} aria-pressed={settled()} disabled={disabled()} class={`ui-session-settle-button pointer-events-auto flex shrink-0 items-center justify-center rounded-md text-icon-weak-base hover:text-icon-base focus-visible:ring-2 focus-visible:ring-border-interactive-base disabled:opacity-30 ${props.compact ? "ui-session-settle-button-compact" : ""}`} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => void toggle(event)}>
        <ClaxedoIcon name={settled() ? "reset" : "check"} size="small" />
      </button>
    </Tooltip>
  )
}
