/**
 * PaneIdContext
 *
 * Provides the current Workbench pane ID to components that need it above
 * SessionParamsProvider (which sits below DirectoryScope).
 */

import { createContext, useContext, type JSX } from "solid-js"

const PaneIdContext = createContext<string>()

export function PaneIdProvider(props: { paneId: string; children: JSX.Element }) {
  return <PaneIdContext.Provider value={props.paneId}>{props.children}</PaneIdContext.Provider>
}

/** Returns the pane ID if inside a PaneIdProvider, or undefined (route-level). */
export function usePaneId(): string | undefined {
  return useContext(PaneIdContext)
}
