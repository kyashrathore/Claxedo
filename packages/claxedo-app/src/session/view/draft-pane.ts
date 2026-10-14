import type { PaneKind } from "@/shell"
import { DraftSessionScreen } from "./draft-session-screen"
import { draftPaneContract, type DraftSessionState } from "./draft-state"
import { useSessionScreenText } from "./text"

export const draftSessionPaneKind: PaneKind<DraftSessionState> = {
  kind: "draftSession",
  title: () => useSessionScreenText()("sessionScreen.draft.title"),
  icon: "plus",
  view: DraftSessionScreen,
  ...draftPaneContract,
}
