/**
 * PaneIdContext
 *
 * Provides the current Workbench pane ID to components that need it above
 * SessionParamsProvider (which sits below DirectoryScope).
 */

import { createContext, useContext } from "solid-js"
import type { JSX } from "@solidjs/web"

const PaneIdContext = createContext<string | null>(null)

export function PaneIdProvider(props: { paneId: string; children: JSX.Element }) {
  return <PaneIdContext value={props.paneId}>{props.children}</PaneIdContext>
}

/** Returns the pane ID if inside a PaneIdProvider, or undefined (route-level). */
export function usePaneId(): string | undefined {
  return useContext(PaneIdContext) ?? undefined
}
