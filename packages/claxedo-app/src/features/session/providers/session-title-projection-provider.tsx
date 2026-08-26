import { createContext, useContext, type JSX, type ParentProps } from "solid-js"
import {
  createSessionTitleProjection,
  type SessionTitleProjectionApi,
} from "@/features/session/store/session-title-projection"

const SessionTitleProjectionContext = createContext<SessionTitleProjectionApi>()

export function SessionTitleProjectionProvider(props: ParentProps): JSX.Element {
  const projection = createSessionTitleProjection()
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
