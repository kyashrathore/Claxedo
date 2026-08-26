import { createContext, useContext, type ParentProps } from "solid-js"
import type { JSX } from "@solidjs/web"
import {
  createSessionTitleProjection,
  type SessionTitleProjectionApi,
} from "@/features/session/store/session-title-projection"

const SessionTitleProjectionContext = createContext<SessionTitleProjectionApi>()

export function SessionTitleProjectionProvider(props: ParentProps): JSX.Element {
  const projection = createSessionTitleProjection()
  return <SessionTitleProjectionContext value={projection}>{props.children}</SessionTitleProjectionContext>
}

export function useSessionTitleProjection() {
  const projection = useContext(SessionTitleProjectionContext)
  if (!projection) throw new Error("useSessionTitleProjection must be used inside SessionTitleProjectionProvider")
  return projection
}
