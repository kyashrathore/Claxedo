import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { canSettle, type SessionRowView } from "@/session"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"
import { railDictionary } from "../i18n"

export function SettleButton(props: { readonly row: SessionRowView; readonly touch: boolean; readonly onToggleSettled: (row: SessionRowView) => Promise<void> }): JSX.Element {
  const t = useTranslator(railDictionary)
  const [busy, setBusy] = createSignal(false)
  return (
    <Tooltip value={t(props.row.settled ? "rail.returnDescription" : "rail.settleDescription")} placement="right" contentClass="max-w-[240px]" class="pointer-events-auto relative z-10 -my-1 shrink-0">
      <button
        type="button"
        data-icon-interaction="row-action"
        aria-label={t(props.row.settled ? "rail.returnSession" : "rail.settleSession", { title: props.row.title })}
        disabled={busy() || !canSettle(props.row)}
        class="flex size-6 items-center justify-center border-none bg-transparent p-0 cursor-pointer disabled:cursor-default disabled:opacity-40"
        classList={{ "ui-session-navigation-settle-touch": props.touch }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setBusy(true)
          void props.onToggleSettled(props.row).finally(() => setBusy(false))
        }}
      >
        <span class="flex items-center leading-none text-icon-weak-base hover:text-icon-base transition-colors">
          <Icon name={props.row.settled ? "reset" : "check"} size="small" />
        </span>
      </button>
    </Tooltip>
  )
}
