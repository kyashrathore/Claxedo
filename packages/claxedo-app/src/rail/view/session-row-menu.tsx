import { onCleanup, onMount, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useAccess } from "@/access"
import { useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { failureMessage } from "@/lib/failure"
import type { SessionRowView } from "@/session"
import { sessionAttention } from "@/server"
import { sessionPath } from "@/shell"
import { showToast, ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui"
import { railDictionary } from "../i18n"

export type SessionRowMenuActions = {
  readonly onRename: (row: SessionRowView) => void
  readonly onToggleSettled: (row: SessionRowView) => Promise<void>
}

const ITEM_CLASS =
  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-13-regular text-text-base enabled:hover:bg-surface-base-active disabled:opacity-50 disabled:cursor-default"

function menuKeys(event: KeyboardEvent, dismiss: () => void): void {
  if (event.key === "Escape" || event.key === "Tab") return dismiss()
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  if (!(event.currentTarget instanceof HTMLElement)) return
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const index = buttons.findIndex((button) => button === document.activeElement)
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

function MenuItem(props: { readonly icon: ClaxedoIconProps["name"]; readonly label: string; readonly disabled?: boolean; readonly onSelect: () => void }): JSX.Element {
  return (
    <button type="button" role="menuitem" class={ITEM_CLASS} disabled={props.disabled} onClick={() => props.onSelect()}>
      <Icon name={props.icon} size="small" /> {props.label}
    </button>
  )
}

export function SessionRowMenu(props: SessionRowMenuActions & { readonly at: { x: number; y: number }; readonly row: SessionRowView; readonly onDismiss: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
  const access = useAccess()
  let menu: HTMLDivElement | undefined
  const trigger = document.activeElement
  const settled = () => props.row.attention && sessionAttention(props.row.attention, props.row.reader).settled
  const settlementDisabled = () => !props.row.attention || (!settled() && (props.row.executionAvailability?.status !== "available" || props.row.attention.working || props.row.attention.awaitingInput))
  onMount(() => menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus())
  onCleanup(() => { if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }) })
  const select = (action: (row: SessionRowView) => unknown) => () => {
    props.onDismiss()
    void action(props.row)
  }
  const copySessionLink = () => {
    props.onDismiss()
    const link = new URL(sessionPath(props.row.ref), window.location.origin).toString()
    void copyText(link).then((result) => {
      if (!result.copied) showToast({ title: t("rail.copyFailed"), description: failureMessage(result.error) })
    })
  }
  return (
    <Portal>
      <div
        class="fixed inset-0 z-[120]"
        onClick={() => props.onDismiss()}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onDismiss()
        }}
      />
      <div
        ref={menu}
        role="menu"
        aria-label={t("rail.sessionMenu", { title: props.row.title })}
        data-surface="overlay"
        data-overlay-shell="prominent"
        class="fixed z-[121] min-w-40 bg-background-stronger p-1"
        style={{ left: `${Math.max(8, Math.min(props.at.x, window.innerWidth - 248))}px`, top: `${Math.max(8, Math.min(props.at.y, window.innerHeight - 192))}px`, width: "240px", "max-width": "calc(100vw - 16px)" }}
        onKeyDown={(event) => menuKeys(event, props.onDismiss)}
      >
        <MenuItem icon="copy" label={t("rail.copySessionLink")} onSelect={copySessionLink} />
        <MenuItem icon="copy" label={t("rail.copyDeepLink")} disabled onSelect={props.onDismiss} />
        <MenuItem icon="pencil-line" label={t("rail.rename")} disabled={!access.session(props.row.ref).owner} onSelect={select(props.onRename)} />
        <MenuItem icon={settled() ? "reset" : "check"} label={t(settled() ? "rail.returnToActive" : "rail.settle")} disabled={settlementDisabled()} onSelect={select(props.onToggleSettled)} />
      </div>
    </Portal>
  )
}
