import { readString } from "@/lib/record"
import { placementId, projectId, sessionId, type SessionRef } from "@/server"
import { useSessionStores } from "@/session"
import type { Json, PaneKind } from "@/shell"
import { SessionScreen } from "./session-screen"
import { useSessionScreenText } from "./text"

export function decodeSessionRef(value: Json): SessionRef | undefined {
  const project = readString(value, "projectId")
  const placement = readString(value, "placementId")
  const session = readString(value, "sessionId")
  if (!project || !placement || !session) return undefined
  return { projectId: projectId(project), placementId: placementId(placement), sessionId: sessionId(session) }
}

function sessionTitle(ref: SessionRef): string {
  const row = useSessionStores()
    .list.rows()
    .find((candidate) => candidate.ref.sessionId === ref.sessionId)
  return row?.title || useSessionScreenText()("sessionScreen.untitled")
}

export const sessionPaneKind: PaneKind<SessionRef> = {
  kind: "session",
  title: sessionTitle,
  icon: "speech-bubble",
  view: SessionScreen,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId, sessionId: state.sessionId }),
  decode: decodeSessionRef,
  fromRoute: (route) => (route.kind === "session" ? { projectId: route.projectId, placementId: route.placementId, sessionId: route.sessionId } : undefined),
  toRoute: (state) => ({ kind: "session", ...state }),
}
