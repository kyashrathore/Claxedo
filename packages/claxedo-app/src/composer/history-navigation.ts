import type { ControllerContext } from "./controller-context"
import type { ContextItem, HistoryComment, HistoryEntry } from "./model"
import { promptText } from "./model"
import { navigateHistory } from "./editor/history"
import { historyComments } from "./send"

function commentItem(comment: HistoryComment): ContextItem {
  return {
    type: "file",
    key: comment.id,
    path: comment.path,
    selection: { startLine: comment.selection.start, endLine: comment.selection.end, startChar: 0, endChar: 0 },
    comment: comment.comment,
    commentId: comment.id,
    ...(comment.origin ? { commentOrigin: comment.origin } : {}),
    ...(comment.preview !== undefined ? { preview: comment.preview } : {}),
  }
}

function applyHistory(context: ControllerContext, entry: HistoryEntry, cursor: "start" | "end"): void {
  const key = context.input.key()
  const position = cursor === "start" ? 0 : promptText(entry.prompt).length
  const kept = context.draft().context.filter((item) => item.type !== "file" || !item.comment?.trim())
  context.input.store.setPrompt(key, entry.prompt, position)
  context.input.store.setContext(key, [...kept, ...entry.comments.map(commentItem)])
  requestAnimationFrame(() => context.focusEditor(position))
}

export function navigateComposerHistory(context: ControllerContext, direction: "up" | "down"): boolean {
  const result = navigateHistory({
    direction,
    entries: context.input.store.history(context.input.key(), context.state.mode),
    historyIndex: context.state.historyIndex,
    currentPrompt: context.draft().prompt,
    currentComments: historyComments(context.draft()),
    savedPrompt: context.state.savedPrompt,
  })
  context.setState({ historyIndex: result.historyIndex, savedPrompt: result.savedPrompt })
  if (result.handled) applyHistory(context, result.entry, result.cursor)
  return result.handled
}
