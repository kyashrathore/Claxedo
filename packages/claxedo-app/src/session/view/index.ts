import { lazyView } from "@/lib/lazy-view"
import type { PanelView } from "@/shell"
export { sessionPaneKind } from "./session-pane"
export { draftSessionPaneKind } from "./draft-pane"
export { subagentPanelView } from "./subagent-panel"

export const sessionDetailsPanelView: PanelView = {
  kind: "context",
  view: lazyView(() => import("./details/details-panel").then((module) => module.SessionDetailsPanel)),
}
