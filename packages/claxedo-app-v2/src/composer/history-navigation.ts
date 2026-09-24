import type { ControllerContext } from "./controller-context"
import type { HistoryEntry } from "./model"
import { promptText } from "./model"
import { navigateHistory } from "./editor/history"

function applyHistory(context: ControllerContext, entry: HistoryEntry, cursor: "start" | "end"): void {
  const position = cursor === "start" ? 0 : promptText(entry.prompt).length
  context.input.store.setPrompt(context.input.key(), entry.prompt, position)
  requestAnimationFrame(() => context.focusEditor(position))
}

export function navigateComposerHistory(context: ControllerContext, direction: "up" | "down"): boolean {
  const result = navigateHistory({
    direction,
    entries: context.input.store.history(context.input.key(), context.state.mode),
    historyIndex: context.state.historyIndex,
    currentPrompt: context.draft().prompt,
    currentComments: [],
    savedPrompt: context.state.savedPrompt,
  })
  context.setState({ historyIndex: result.historyIndex, savedPrompt: result.savedPrompt })
  if (result.handled) applyHistory(context, result.entry, result.cursor)
  return result.handled
}
