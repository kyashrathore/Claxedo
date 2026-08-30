import { createComputed, createContext, useContext, type Accessor, type JSX, type ParentProps } from "solid-js"
import {
  createSessionTitleProjection,
  type SessionTitleProjectionApi,
} from "@/features/session/store/session-title-projection"

const SessionTitleProjectionContext = createContext<SessionTitleProjectionApi>()

export function SessionTitleProjectionProvider(props: ParentProps<{ scope?: Accessor<string> }>): JSX.Element {
  const projection = createSessionTitleProjection()
  let previousScope: string | undefined
  createComputed(() => {
    const nextScope = props.scope?.()
    if (nextScope === undefined || previousScope === undefined) {
      previousScope = nextScope
      return
    }
    if (nextScope === previousScope) return
    previousScope = nextScope
    projection.clear()
  })
  return (
    <SessionTitleProjectionContext.Provider value={projection}>
      {props.children}
    </SessionTitleProjectionContext.Provider>
  )
}

export function useSessionTitleProjection() {
  const projection = useContext(SessionTitleProjectionContext)
  if (!projection) throw new Error("useSessionTitleProjection must be used inside SessionTitleProjectionProvider")
  return projection
}
