import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useTranslator } from "@/i18n"
import type { SessionRowView } from "@/session"
import { ClaxedoIcon as Icon, type ClaxedoIconProps } from "@/ui/controls/claxedo-icon"
import { dictionary } from "../i18n"

export type SessionRowMenuActions = {
  readonly onRename: (row: SessionRowView) => void
  readonly onArchive: (row: SessionRowView) => Promise<void>
  readonly onDelete: (row: SessionRowView) => void
}

const ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 h-9 text-13-regular text-text-base enabled:hover:bg-surface-base-active disabled:opacity-50 disabled:cursor-default"

function MenuItem(props: { readonly icon: ClaxedoIconProps["name"]; readonly label: string; readonly onSelect: () => void }): JSX.Element {
  return (
    <button type="button" role="menuitem" class={ITEM_CLASS} onClick={() => props.onSelect()}>
      <Icon name={props.icon} size="small" /> {props.label}
    </button>
  )
}

export function SessionRowMenu(props: SessionRowMenuActions & { readonly at: { x: number; y: number }; readonly row: SessionRowView; readonly onDismiss: () => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const select = (action: (row: SessionRowView) => unknown) => () => {
    props.onDismiss()
    void action(props.row)
  }
  return (
    <Portal>
      <div
        data-slot="session-navigation-menu-dismiss"
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
        data-slot="session-navigation-menu"
        class="fixed z-[91] min-w-40 bg-background-stronger p-1"
        style={{ left: `${props.at.x}px`, top: `${props.at.y}px` }}
        onKeyDown={(event) => event.key === "Escape" && props.onDismiss()}
      >
        <MenuItem icon="pencil-line" label={t("rail.rename")} onSelect={select(props.onRename)} />
        <MenuItem icon="archive" label={t("rail.archive")} onSelect={select(props.onArchive)} />
        <MenuItem icon="trash" label={t("rail.delete")} onSelect={select(props.onDelete)} />
      </div>
    </Portal>
  )
}
