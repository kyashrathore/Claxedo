import { createContext, onCleanup, useContext, type Accessor } from "solid-js"

export type PaneContext = {
  readonly holdReveal: (pending: Accessor<boolean>) => () => void
}

const Context = createContext<PaneContext>()

export const PaneContextProvider = Context.Provider

export function holdPaneReveal(pending: Accessor<boolean>): void {
  const release = useContext(Context)?.holdReveal(pending)
  if (release) onCleanup(release)
}
