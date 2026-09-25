import { readString } from "@/lib/record"
import { placementId, projectId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { DraftSessionScreen, type DraftSessionState } from "./draft-session-screen"
import { useSessionScreenText } from "./text"

function decodeDraft(value: Json): DraftSessionState | undefined {
  const project = readString(value, "projectId")
  const placement = readString(value, "placementId")
  if (!project || !placement) return undefined
  return { projectId: projectId(project), placementId: placementId(placement) }
}

export const draftSessionPaneKind: PaneKind<DraftSessionState> = {
  kind: "draftSession",
  title: () => useSessionScreenText()("sessionScreen.draft.title"),
  icon: "plus",
  view: DraftSessionScreen,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId }),
  decode: decodeDraft,
  fromRoute: (route) => (route.kind === "draft" ? { projectId: route.projectId, placementId: route.placementId } : undefined),
  toRoute: (state) => ({ kind: "draft", projectId: state.projectId, placementId: state.placementId }),
}
