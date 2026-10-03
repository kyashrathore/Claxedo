import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { copyText } from "@/lib/clipboard"
import { failureMessage } from "@/lib/failure"
import { canSettle, type SessionRowView } from "@/session"
import { sessionPath } from "@/shell"
import { showToast, ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui"
import { railDictionary } from "../i18n"

export type SessionRowMenuActions = {
  readonly onRename: (row: SessionRowView) => void
  readonly onToggleSettled: (row: SessionRowView) => Promise<void>
}

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 h-9 text-13-regular text-text-base enabled:hover:bg-surface-base-active disabled:opacity-50 disabled:cursor-default"

function MenuItem(props: { readonly icon: ClaxedoIconProps["name"]; readonly label: string; readonly disabled?: boolean; readonly onSelect: () => void }): JSX.Element {
  return (
    <button type="button" role="menuitem" class={ITEM_CLASS} disabled={props.disabled} onClick={() => props.onSelect()}>
      <Icon name={props.icon} size="small" /> {props.label}
    </button>
  )
}

export function SessionRowMenu(props: SessionRowMenuActions & { readonly at: { x: number; y: number }; readonly row: SessionRowView; readonly onDismiss: () => void }): JSX.Element {
  const t = useTranslator(railDictionary)
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
        class="fixed inset-0 z-[90]"
        onClick={() => props.onDismiss()}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onDismiss()
        }}
      />
      <div
        role="menu"
        aria-label={t("rail.sessionMenu", { title: props.row.title })}
        data-surface="overlay"
        data-overlay-shell="prominent"
        class="fixed z-[91] min-w-40 bg-background-stronger p-1"
        style={{ left: `${props.at.x}px`, top: `${props.at.y}px` }}
        onKeyDown={(event) => event.key === "Escape" && props.onDismiss()}
      >
        <MenuItem icon="copy" label={t("rail.copySessionLink")} onSelect={copySessionLink} />
        <MenuItem icon="copy" label={t("rail.copyDeepLink")} disabled onSelect={props.onDismiss} />
        <MenuItem icon="pencil-line" label={t("rail.rename")} onSelect={select(props.onRename)} />
        <MenuItem
          icon={props.row.settled ? "reset" : "check"}
          label={t(props.row.settled ? "rail.returnToActive" : "rail.settle")}
          disabled={!canSettle(props.row)}
          onSelect={select(props.onToggleSettled)}
        />
      </div>
    </Portal>
  )
}
