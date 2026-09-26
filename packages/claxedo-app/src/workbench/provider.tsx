import { createContext, useContext, type JSX } from "solid-js"
import type { WorkbenchStore } from "./store"

const WorkbenchContext = createContext<WorkbenchStore>()

export function WorkbenchProvider(props: { readonly store: WorkbenchStore; readonly children: JSX.Element }): JSX.Element {
  return <WorkbenchContext.Provider value={props.store}>{props.children}</WorkbenchContext.Provider>
}

export function useWorkbench(): WorkbenchStore {
  const store = useContext(WorkbenchContext)
  if (!store) throw new Error("useWorkbench needs a WorkbenchProvider above it")
  return store
}
