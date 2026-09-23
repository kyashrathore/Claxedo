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
  NavigationStatusMark: typeof Navigation.NavigationStatusMark
  NavigationRowGlyph: typeof Navigation.NavigationRowGlyph
  NavigationRowStatusGutter: typeof Navigation.NavigationRowStatusGutter
  workspacePlacement: typeof WorkspaceConnection.workspaceRelayPlacement
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

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: TerminalAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const useSDK = bind((ports) => ports.useSDK)
export const useClaxedoEventsOptional = bind((ports) => ports.useClaxedoEventsOptional)
export const useClaxedoState = bind((ports) => ports.useClaxedoState)
export type ContentMeta = State.ContentMeta
export type PaneCtx = Workbench.PaneCtx
export const SessionPaneScope = bind((ports) => ports.SessionPaneScope)
export type SwitcherStatus = SwitcherItems.SwitcherStatus
export const NavigationRow = bind((ports) => ports.NavigationRow)
export const NavigationStatusMark = bind((ports) => ports.NavigationStatusMark)
export const NavigationRowGlyph = bind((ports) => ports.NavigationRowGlyph)
export const NavigationRowStatusGutter = bind((ports) => ports.NavigationRowStatusGutter)
export type NavigationDragStart = SessionNavigation.NavigationDragStart
export type RowActivityDetail = SessionNavigation.RowActivityDetail
export type TerminalSurfaceRow = SessionNavigation.TerminalSurfaceRow
export const workspacePlacement = bind((ports) => ports.workspacePlacement)
export type ActionProps = LayoutActions.ActionProps
export type Nav = LayoutActions.Nav
export const recoverMissingWorkspace = bind((ports) => ports.recoverMissingWorkspace)
export const TerminalNewView = bind((ports) => ports.TerminalNewView)
