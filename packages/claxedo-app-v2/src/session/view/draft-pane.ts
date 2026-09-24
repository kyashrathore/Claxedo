import { readString } from "@/lib/record"
import { placementId, projectId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { DraftSessionScreen, type DraftSessionState } from "./draft-session-screen"
import { useSessionScreenText } from "./text"

function decodeDraft(value: Json): DraftSessionState | undefined {
  const project = readString(value, "projectId")
  const placement = readString(value, "placementId")
  const draft = readString(value, "draftId")
  if (!project || !placement || !draft) return undefined
  return { projectId: projectId(project), placementId: placementId(placement), draftId: draft }
}

export const draftSessionPaneKind: PaneKind<DraftSessionState> = {
  kind: "draftSession",
  title: () => useSessionScreenText()("sessionScreen.draft.title"),
  icon: "plus",
  view: DraftSessionScreen,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId, draftId: state.draftId }),
  decode: decodeDraft,
}
