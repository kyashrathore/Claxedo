import { createContext, useContext, type JSX } from "solid-js"
import type { PaneCtx } from "../workbench/workbench"

const PaneCtxContext = createContext<PaneCtx>()

/** Mounted by the workbench slot, so every surface below it reads the slot's own answer. */
export function PaneCtxProvider(props: { ctx: PaneCtx; children: JSX.Element }) {
  return <PaneCtxContext.Provider value={props.ctx}>{props.children}</PaneCtxContext.Provider>
}

/** The workbench slot this component renders in; `undefined` outside the workbench. */
export function usePaneCtx(): PaneCtx | undefined {
  return useContext(PaneCtxContext)
}
