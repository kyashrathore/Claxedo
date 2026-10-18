import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceProgram } from "@claxedo/plugin-api"
import { COLUMNS, addTask, deleteTask, localIsoDate, moveTask, parseOwnerFilter, parseTaskDraft, seedBoard, setWipLimit, type Board, type BoardResult } from "./model"
import {
  boardDisplay,
  composeBody,
  displayPatches,
  emptyDraft,
  initialData,
  openingMessages,
  replaceComponents,
  rootComponent,
  sprintBoardComponents,
  update,
  wipData,
  type BoardDisplay,
  type Notice,
  type ViewContext,
} from "./surface"

const PAGE_ID = "sprint-board"

function projectName(api: PluginApi): string | undefined {
  const id = api.context.currentProjectId() ?? api.projects.currentId()
  return api.projects.list().find((project) => project.id === id)?.name
}

function openBoard(api: PluginApi, store: { board: Board }, channel: SurfaceChannel, composeOpen: boolean): SurfaceProgram {
  const { surfaceId } = channel
  const formatter = new Intl.DateTimeFormat(api.context.locale, { month: "short", day: "numeric", timeZone: "UTC" })
  let owners: string[] = []
  const session = { added: 0, removed: 0 }
  const shownCallouts = { notice: false, compose: false }
  const context = (): ViewContext => ({
    today: localIsoDate(new Date()),
    owners,
    projectName: projectName(api),
    session,
    formatDate: (iso) => formatter.format(new Date(`${iso}T00:00:00Z`)),
  })
  let shown: BoardDisplay = boardDisplay(store.board, context())
  channel.send(...openingMessages(surfaceId, sprintBoardComponents(composeOpen), initialData(store.board, shown, owners, context().today)))

  const refresh = () => {
    const next = boardDisplay(store.board, context())
    const patches = displayPatches(surfaceId, shown, next)
    shown = next
    if (patches.length > 0) channel.send(...patches)
  }

  const showNotice = (notice: Notice | undefined) => {
    if (notice) channel.send(update(surfaceId, "/notice", notice))
    if (shownCallouts.notice !== (notice !== undefined)) channel.send(replaceComponents(surfaceId, [rootComponent(notice !== undefined)]))
    shownCallouts.notice = notice !== undefined
  }

  const showComposeError = (error: Notice | undefined) => {
    if (error) channel.send(update(surfaceId, "/compose/error", error))
    if (shownCallouts.compose !== (error !== undefined)) channel.send(replaceComponents(surfaceId, [composeBody(error !== undefined)]))
    shownCallouts.compose = error !== undefined
  }

  const commit = (result: BoardResult, refusalTitle: string): boolean => {
    if (!result.ok) {
      showNotice({ title: refusalTitle, text: result.error })
      return false
    }
    store.board = result.board
    showNotice(undefined)
    refresh()
    return true
  }

  return {
    async action(action) {
      const today = localIsoDate(new Date())
      switch (action.name) {
        case "applyFilter":
          owners = parseOwnerFilter(action.context.owners)
          refresh()
          return
        case "clearFilter":
          owners = []
          channel.send(update(surfaceId, "/filter/owners", []))
          refresh()
          return
        case "addTask": {
          const parsed = parseTaskDraft(action.context.draft, store.board.sprint)
          const result = parsed.ok ? addTask(store.board, parsed.draft) : parsed
          if (!result.ok) {
            showComposeError({ title: "Task not added", text: result.error })
            return
          }
          showComposeError(undefined)
          session.added += 1
          commit(result, "Task not added")
          channel.send(update(surfaceId, "/draft", emptyDraft(today)))
          api.ui.toast({ kind: "success", title: "Task added", description: result.message })
          return
        }
        case "move": {
          const id = typeof action.context.id === "string" ? action.context.id : ""
          const step = typeof action.context.step === "number" ? action.context.step : 0
          commit(moveTask(store.board, id, step, today), "Move refused")
          return
        }
        case "delete": {
          const id = typeof action.context.id === "string" ? action.context.id : ""
          const task = store.board.tasks.find((entry) => entry.id === id)
          if (!task) return
          const confirmed = await api.ui.confirm({
            title: `Delete ${task.id}?`,
            description: `“${task.title}” and its ${task.points} points leave the sprint. This cannot be undone.`,
            confirmLabel: "Delete task",
          })
          if (!confirmed) return
          const result = deleteTask(store.board, id)
          if (result.ok) session.removed += 1
          if (!commit(result, "Delete failed") || !result.ok) return
          api.ui.toast({ kind: "info", title: "Task deleted", description: result.message })
          return
        }
        case "saveWip": {
          const column = typeof action.context.column === "string" ? action.context.column : ""
          const result = setWipLimit(store.board, column, action.context.enforce, action.context.limit)
          if (!commit(result, "WIP limit not saved") || !result.ok) return
          const index = COLUMNS.findIndex((entry) => entry.id === column)
          const entry = COLUMNS[index]
          if (!entry) return
          channel.send(update(surfaceId, `/columns/${index}/wip`, wipData(store.board, entry.id)))
          api.ui.toast({ kind: "success", title: "WIP limit saved", description: result.message })
          return
        }
      }
    },
  }
}

export default definePlugin({
  activate(api) {
    const store = { board: seedBoard(localIsoDate(new Date())) }
    api.pages.register({
      id: PAGE_ID,
      path: "/sprint-board",
      title: "Sprint board",
      surface: (channel, props) => openBoard(api, store, channel, props.params.compose === "1"),
    })
    api.sidebar.item({ id: PAGE_ID, label: "Sprint board", pageId: PAGE_ID, icon: "checklist", badge: () => store.board.tasks.filter((task) => task.column === "review").length || undefined })
    api.commands.register({ id: "sprint-board.open", title: "Open sprint board", category: "Sprint board", run: () => api.pages.open(PAGE_ID) })
    api.commands.register({ id: "sprint-board.add-task", title: "Add a sprint task", category: "Sprint board", run: () => api.pages.open(PAGE_ID, { compose: "1" }) })
  },
})
