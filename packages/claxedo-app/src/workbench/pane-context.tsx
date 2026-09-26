import { createContext, onCleanup, useContext, type Accessor } from "solid-js"

export type PaneContext = {
  readonly paneId: () => string | null
  readonly isFocused: () => boolean
  readonly isVisible: () => boolean
  readonly element: () => HTMLDivElement | undefined
  readonly onKeyDown: (handler: (event: KeyboardEvent) => void) => void
  readonly requestClose: (opts?: { destroyContent: boolean }) => void
  readonly requestFocus: () => void
  readonly holdReveal: (pending: Accessor<boolean>) => () => void
}

const Context = createContext<PaneContext>()

export const PaneContextProvider = Context.Provider

export function usePaneContext(): PaneContext {
  const pane = useContext(Context)
  if (!pane) throw new Error("usePaneContext needs a workbench pane above it")
  return pane
}

export function holdPaneReveal(pending: Accessor<boolean>): void {
  const release = useContext(Context)?.holdReveal(pending)
  if (release) onCleanup(release)
}
