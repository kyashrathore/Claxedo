import { createSignal, Show, type JSX } from "solid-js"
import type { SessionRowView } from "@/session"
import { useServer } from "@/server"
import { sessionLinkPath, useShellRoute } from "@/shell"
import { useWorkbench } from "@/workbench"
import type { ClaxedoIconProps } from "@/ui"
import { createHoverEngagement } from "../hover-engagement"
import { NavigationRow } from "./navigation-row"
import { ActivityStatusMark } from "./activity-status-mark"
import { SettleSessionButton } from "./settle-session-button"
import { SessionNavigationTitle } from "./session-navigation-title"
import { ActivityPlacement } from "./activity-placement"
import { SessionRowMenu, type SessionRowMenuActions } from "./session-row-menu"
import "../session-navigation.css"

export type ActivityRowProps = SessionRowMenuActions & {
  readonly row: SessionRowView
  readonly projectName: string
  readonly placementName: string
  readonly placementIcon: ClaxedoIconProps["name"]
}

export function ActivityRow(props: ActivityRowProps): JSX.Element {
  const server = useServer()
  const routing = useShellRoute()
  const workbench = useWorkbench()
  const engagement = createHoverEngagement()
  const [menu, setMenu] = createSignal<{ x: number; y: number }>()
  const active = () => {
    const content = workbench.selectors.shownContent()
    const route = content ? workbench.routeOf(content) : undefined
    return route?.kind === "session" && route.sessionId === props.row.ref.sessionId
  }
  const navigate = () => routing.navigate(sessionLinkPath(props.row.ref, server.placements.byId(props.row.ref.placementId), server.capabilities()?.thisMachine?.id))
  const openMenu = (event: MouseEvent) => {
    event.preventDefault()
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.querySelector<HTMLButtonElement>('[data-slot="navigation-row-activate"]')?.focus()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <NavigationRow label={props.row.title} active={active()} engagement={engagement} class="ui-activity-row px-2" data={{ "data-testid": "activity-session-row", "data-session-id": props.row.ref.sessionId, "data-slot": "session-navigation-row" }} onActivate={navigate} prepareDrag={() => workbench.openRoute({ kind: "session", ...props.row.ref }, false)} onKeyboardMenu={setMenu} onContextMenu={openMenu}>
      <div class="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex h-4 min-w-0 items-center gap-2 leading-4">
          <SessionNavigationTitle value={props.row.title} engagement={engagement} class="ui-session-navigation-title" />
          <ActivityStatusMark row={props.row} />
        </div>
        <div class="flex min-w-0 items-center gap-1 text-xs text-text-weaker">
          <span class="truncate">{props.projectName}</span>
          <ActivityPlacement name={props.placementName} icon={props.placementIcon} engagement={engagement} />
        </div>
      </div>
      <div class="ui-session-navigation-settle">
        <SettleSessionButton row={props.row} compact onToggleSettled={props.onToggleSettled} />
      </div>
      <Show when={menu()}>{(at) => <SessionRowMenu at={at()} row={props.row} onRename={props.onRename} onToggleSettled={props.onToggleSettled} onDismiss={() => setMenu(undefined)} />}</Show>
    </NavigationRow>
  )
}
