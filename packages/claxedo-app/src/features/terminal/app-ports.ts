import type * as SDK from "@/app/providers/sdk/sdk"
import type * as Events from "@/app/integrations/claxedo-events"
import type * as State from "@/app/workbench/state"
import type * as Workbench from "@/app/workbench/workbench"
import type * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import type * as SwitcherItems from "@/app/workbench/compact-switcher/switcher-items"
import type * as Navigation from "@/app/workbench/navigation/navigation-row"
import type * as SessionNavigation from "@/features/session/ui/navigation/session-navigation"
import type * as WorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import type * as LayoutActions from "@/app/workbench/actions/shared"
import type * as WorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import type * as TerminalNew from "@/app/workbench/terminal/terminal-new-view"

export type TerminalAppPorts = {
  useSDK: typeof SDK.useSDK
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
  useClaxedoState: typeof State.useClaxedoState
  SessionPaneScope: typeof SessionScope.SessionPaneScope
  NavigationRow: typeof Navigation.NavigationRow
  NavigationStatusDot: typeof Navigation.NavigationStatusDot
  NavigationRowGlyph: typeof Navigation.NavigationRowGlyph
  NavigationRowStatusGutter: typeof Navigation.NavigationRowStatusGutter
  workspacePlacement: typeof WorkspaceConnection.workspacePlacement
  recoverMissingWorkspace: typeof WorkspaceRecovery.recoverMissingWorkspace
  /**
   * The creator shown for a terminal surface still in its `new` state. It lives
   * in `app/` because it composes the session composer's placement chips with
   * the workspaces provisioning flow — two features this one may not import.
   */
  TerminalNewView: typeof TerminalNew.TerminalNewView
}

let ports: TerminalAppPorts | undefined

export function configureTerminalAppPorts(value: TerminalAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Terminal app ports are not configured")
  return ports
}

function bind<K extends keyof TerminalAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as TerminalAppPorts[K]
}

export const useSDK = bind("useSDK")
export const useClaxedoEventsOptional = bind("useClaxedoEventsOptional")
export const useClaxedoState = bind("useClaxedoState")
export type ContentMeta = State.ContentMeta
export type PaneCtx = Workbench.PaneCtx
export const SessionPaneScope = bind("SessionPaneScope")
export type SwitcherStatus = SwitcherItems.SwitcherStatus
export const NavigationRow = bind("NavigationRow")
export const NavigationStatusDot = bind("NavigationStatusDot")
export const NavigationRowGlyph = bind("NavigationRowGlyph")
export const NavigationRowStatusGutter = bind("NavigationRowStatusGutter")
export type NavigationDragStart = SessionNavigation.NavigationDragStart
export type RowActivityDetail = SessionNavigation.RowActivityDetail
export type TerminalSurfaceRow = SessionNavigation.TerminalSurfaceRow
export const workspacePlacement = bind("workspacePlacement")
export type ActionProps = LayoutActions.ActionProps
export type Nav = LayoutActions.Nav
export const recoverMissingWorkspace = bind("recoverMissingWorkspace")
export const TerminalNewView = bind("TerminalNewView")
