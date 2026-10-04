import { prefixedRandomId } from "@claxedo/helpers/crypto"
import { readString } from "@claxedo/helpers/readers"
import { placementId, projectId } from "@/server"
import type { Json, PaneKind } from "@/shell"
import { DraftSessionScreen, type DraftSessionState } from "./draft-session-screen"
import { useSessionScreenText } from "./text"

export function newDraft(target: Omit<DraftSessionState, "draftId">): DraftSessionState {
  return { ...target, draftId: prefixedRandomId("draft") }
}

function decodeDraft(value: Json): DraftSessionState | undefined {
  const project = readString(value, "projectId")
  const placement = readString(value, "placementId")
  const draftId = readString(value, "draftId")
  if (!project || !placement || !draftId) return undefined
  return { projectId: projectId(project), placementId: placementId(placement), draftId }
}

export const draftSessionPaneKind: PaneKind<DraftSessionState> = {
  kind: "draftSession",
  title: () => useSessionScreenText()("sessionScreen.draft.title"),
  icon: "plus",
  view: DraftSessionScreen,
  encode: (state) => ({ projectId: state.projectId, placementId: state.placementId, draftId: state.draftId }),
  decode: decodeDraft,
  fromRoute: (route) => (route.kind === "draft" ? newDraft({ projectId: route.projectId, placementId: route.placementId }) : undefined),
  toRoute: (state) => ({ kind: "draft", projectId: state.projectId, placementId: state.placementId }),
}
