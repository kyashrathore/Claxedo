import { definePlugin, type SurfaceActionEvent } from "@claxedo/plugin-api"
import {
  absorbView,
  addNote,
  applySettings,
  COLUMN_IDS,
  convertToAction,
  createBoard,
  exportMarkdown,
  followUpPrompt,
  mergeSelected,
  removeNote,
  startTimer,
  stopTimer,
  timerRemaining,
  vote,
  type Board,
  type ColumnId,
} from "./model"
import { boardMessages, columnBody, components, followUpStatus, openMessages, patch, retroModel, timerData } from "./view"

const PAGE_ID = "retro-board"

function contextText(action: SurfaceActionEvent, key: string): string {
  const value = action.context[key]
  return typeof value === "string" ? value : ""
}

function today(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function filledColumns(board: Board): Record<ColumnId, boolean> {
  return { well: false, improve: false, actions: false, ...Object.fromEntries(board.notes.map((item) => [item.column, true])) }
}

export default definePlugin({
  activate(api) {
    let board: Board = createBoard()
    const listeners = new Set<() => void>()

    api.sidebar.item({ id: "retro-board", label: "Retro board", pageId: PAGE_ID, icon: "comment" })

    api.pages.register({
      id: PAGE_ID,
      path: "/retro-board",
      title: "Retro board",
      surface(channel) {
        const { surfaceId } = channel
        let filled = filledColumns(board)
        let ticker: ReturnType<typeof setInterval> | undefined

        const render = (next: Board) => {
          board = next
          const now = filledColumns(board)
          const swaps = COLUMN_IDS.filter((column) => now[column] !== filled[column]).map((column) => columnBody(column, now[column]))
          filled = now
          channel.send(...(swaps.length > 0 ? [components(surfaceId, swaps)] : []), ...boardMessages(surfaceId, board))
        }

        const stopTicker = () => {
          if (ticker !== undefined) clearInterval(ticker)
          ticker = undefined
        }

        const onTick = () => {
          const now = Date.now()
          channel.send(patch(surfaceId, "/timer", timerData(board, now)))
          if (timerRemaining(board.timer, now) > 0) return
          stopTicker()
          api.ui.toast({ kind: "info", title: "Time is up", description: "Wrap up this round and move to the next column." })
        }

        const syncTicker = () => {
          if (board.timer.endsAt !== null && timerRemaining(board.timer, Date.now()) > 0 && ticker === undefined) ticker = setInterval(onTick, 1000)
          if (board.timer.endsAt === null) stopTicker()
        }

        const resetView = () => {
          filled = filledColumns(board)
          channel.send(components(surfaceId, COLUMN_IDS.map((column) => columnBody(column, filled[column]))), patch(surfaceId, "/", retroModel(board, Date.now())))
          stopTicker()
        }
        listeners.add(resetView)

        channel.send(...openMessages(surfaceId, board, Date.now()))
        syncTicker()

        const refuse = (title: string, description?: string) => api.ui.toast({ kind: "warning", title, description })

        const followUp = async (current: Board) => {
          const prompt = followUpPrompt(current, today())
          if (!prompt) {
            refuse("No action items yet", "Convert a to-improve note into an action first.")
            return
          }
          const projectId = api.context.currentProjectId() ?? api.projects.currentId()
          if (!projectId) {
            refuse("Open a project first", "The follow-up session starts in the current project.")
            return
          }
          channel.send(components(surfaceId, [followUpStatus(true)]))
          try {
            const ref = await api.sessions.create({ projectId, title: `Retro follow-up ${today()}`, prompt })
            channel.send(patch(surfaceId, "/export/status", `Follow-up session ${api.sessions.status(ref)}`))
            api.sessions.open(ref)
          } catch (error) {
            api.ui.toast({ kind: "error", title: "Could not start the session", description: error instanceof Error ? error.message : String(error) })
          } finally {
            channel.send(components(surfaceId, [followUpStatus(false)]))
          }
        }

        return {
          async action(action) {
            const current = applySettings(absorbView(board, action.context.view), action.context.settings)
            switch (action.name) {
              case "applySettings":
                render(current)
                channel.send(patch(surfaceId, "/timer", timerData(board, Date.now())))
                return
              case "addNote": {
                const column = contextText(action, "column")
                const change = addNote(current, column, contextText(action, "text"))
                if (change.error) {
                  refuse("Note not added", change.error)
                  return
                }
                render(change.board)
                channel.send(patch(surfaceId, `/drafts/${column}`, ""))
                return
              }
              case "vote": {
                const change = vote(current, contextText(action, "id"))
                if (change.error) {
                  render(current)
                  refuse("Vote not counted", change.error)
                  return
                }
                render(change.board)
                return
              }
              case "merge": {
                const change = mergeSelected(current)
                if (change.error) {
                  render(current)
                  refuse("Nothing merged", change.error)
                  return
                }
                render(change.board)
                api.ui.toast({ kind: "success", title: "Notes merged", description: "Their votes were added together." })
                return
              }
              case "convert": {
                const change = convertToAction(current, contextText(action, "id"), contextText(action, "owner"), contextText(action, "due"))
                if (change.error) {
                  render(current)
                  refuse("No action created", change.error)
                  return
                }
                render(change.board)
                api.ui.toast({ kind: "success", title: "Action created", description: "It is in the Actions column." })
                return
              }
              case "remove": {
                const ok = await api.ui.confirm({ title: "Remove this action?", description: contextText(action, "text"), confirmLabel: "Remove" })
                render(ok ? removeNote(current, contextText(action, "id")) : current)
                return
              }
              case "startTimer":
                render(startTimer(current, Date.now()))
                channel.send(patch(surfaceId, "/timer", timerData(board, Date.now())))
                syncTicker()
                return
              case "stopTimer":
                render(stopTimer(current))
                stopTicker()
                channel.send(patch(surfaceId, "/timer", timerData(board, Date.now())))
                return
              case "export":
                render(current)
                channel.send(patch(surfaceId, "/export/markdown", exportMarkdown(board, today())))
                api.ui.toast({ kind: "success", title: "Retro exported", description: "The Markdown tab has the source to copy." })
                return
              case "followUp":
                render(current)
                await followUp(current)
                return
            }
          },
          dispose() {
            listeners.delete(resetView)
            stopTicker()
          },
        }
      },
    })

    api.commands.register({
      id: "retro-board.open",
      title: "Open retro board",
      category: "Retro",
      run: () => api.pages.open(PAGE_ID),
    })

    api.commands.register({
      id: "retro-board.clear",
      title: "Start a fresh retro board",
      category: "Retro",
      run: async () => {
        const ok = await api.ui.confirm({ title: "Start a fresh retro?", description: "Every note, vote and action on the board is cleared.", confirmLabel: "Clear board" })
        if (!ok) return
        board = createBoard(false, board.timer.durationSeconds / 60)
        for (const listener of listeners) listener()
        api.ui.toast({ kind: "success", title: "Fresh retro board ready" })
      },
    })
  },
})
