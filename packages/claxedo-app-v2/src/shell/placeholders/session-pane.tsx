import type { JSX } from "solid-js"
import { isRecord, readString } from "@/lib/record"
import { placementId, projectId, sessionId, type SessionRef } from "@/server"
import type { PaneKind, PaneProps } from "../types"
import { useSessionStores } from "./session-stores"

function SessionPanePlaceholder(props: PaneProps<SessionRef>): JSX.Element {
  const stores = useSessionStores()
  const view = stores.open(props.state)
  return (
    <div class="shell-placeholder-pane" data-testid="session-pane-placeholder" data-session-id={props.state.sessionId}>
      <p>{view.row()?.title ?? props.state.sessionId}</p>
      <p>{view.status().kind}</p>
    </div>
  )
}

export const sessionPaneKind: PaneKind<SessionRef> = {
  kind: "session",
  title: (state) => useSessionStores().open(state).row()?.title ?? state.sessionId,
  icon: "speech-bubble",
  view: SessionPanePlaceholder,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId, sessionId: state.sessionId }),
  decode: (value) => {
    if (!isRecord(value)) return undefined
    const project = readString(value, "projectId")
    const placement = readString(value, "placementId")
    const session = readString(value, "sessionId")
    if (!project || !placement || !session) return undefined
    return { projectId: projectId(project), placementId: placementId(placement), sessionId: sessionId(session) }
  },
  fromRoute: (route) => (route.kind === "session" ? { projectId: route.projectId, placementId: route.placementId, sessionId: route.sessionId } : undefined),
  toRoute: (state) => ({ kind: "session", ...state }),
}
