import { readString } from "@claxedo/helpers/readers"
import { placementId, projectId, sessionId, type SessionLocation } from "@/server"
import { useSessionStores } from "@/session"
import type { Json, PaneKind } from "@/shell"
import { SessionScreen } from "./session-screen"
import { useSessionScreenText } from "./text"

export function decodeSessionLocation(value: Json): SessionLocation | undefined {
  const project = readString(value, "projectId")
  const placement = readString(value, "placementId")
  const session = readString(value, "sessionId")
  if (!project || !placement || !session) return undefined
  return { projectId: projectId(project), placementId: placementId(placement), sessionId: sessionId(session) }
}

function paneTitle(ref: SessionLocation): string {
  return useSessionStores().list.view(ref.sessionId)?.title || useSessionScreenText()("sessionScreen.untitled")
}

export const sessionPaneKind: PaneKind<SessionLocation> = {
  kind: "session",
  title: paneTitle,
  icon: "speech-bubble",
  view: SessionScreen,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId, sessionId: state.sessionId }),
  decode: decodeSessionLocation,
  fromRoute: (route) => (route.kind === "session" ? { projectId: route.projectId, placementId: route.placementId, sessionId: route.sessionId } : undefined),
  toRoute: (state) => ({ kind: "session", ...state }),
}
