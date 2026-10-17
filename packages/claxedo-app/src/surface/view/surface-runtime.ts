import { createContext, useContext, type Accessor } from "solid-js"
import type { SurfaceActionDefinition } from "@claxedo/plugin-api/surface"
import { boundNumber, boundText, readDynamic, type Bindable } from "../binding"
import type { DataPath, SurfaceState } from "../model"

export type SurfaceRuntime = {
  readonly state: SurfaceState
  readonly actionsDisabled: Accessor<boolean>
  readonly fire: (action: SurfaceActionDefinition, sourceComponentId: string, scope: DataPath) => void
}

export type SurfaceReader = {
  readonly value: (source: unknown, scope: DataPath) => unknown
  readonly text: (source: Bindable<string> | undefined, scope: DataPath) => string
  readonly number: (source: Bindable<number> | undefined, scope: DataPath) => number
}

const SurfaceRuntimeContext = createContext<SurfaceRuntime>()

export const SurfaceRuntimeProvider = SurfaceRuntimeContext.Provider

export function useSurfaceRuntime(): SurfaceRuntime {
  const runtime = useContext(SurfaceRuntimeContext)
  if (!runtime) throw new Error("a surface component needs a SurfaceView above it")
  return runtime
}

export function useSurfaceReader(): SurfaceReader {
  const data = useSurfaceRuntime().state.data
  return {
    value: (source, scope) => readDynamic(source, scope, data),
    text: (source, scope) => boundText(readDynamic(source, scope, data)),
    number: (source, scope) => boundNumber(readDynamic(source, scope, data)),
  }
}
