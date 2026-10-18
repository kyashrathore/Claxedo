import { definePlugin, type SurfaceActionEvent } from "@claxedo/plugin-api"
import {
  addTask,
  applySettings,
  createFocusState,
  formatClock,
  isMode,
  MODE_LABEL,
  pause,
  readSettings,
  removeTask,
  reset,
  selectTask,
  skip,
  start,
  switchMode,
  tick,
  toggle,
  toggleTaskDone,
  type FocusState,
  type LogEntry,
} from "./model"
import { components, logBody, noticeMessages, openMessages, patch, remainingData, stateMessages, tasksBody, type Notice } from "./view"

const PAGE_ID = "focus-timer"

function contextText(action: SurfaceActionEvent, key: string): string {
  const value = action.context[key]
  return typeof value === "string" ? value : ""
}

export default definePlugin({
  activate(api) {
    let state: FocusState = createFocusState()
    const listeners = new Set<(finished: LogEntry | null) => void>()
    const commit = (next: FocusState, finished: LogEntry | null = null) => {
      state = next
      for (const listener of listeners) listener(finished)
    }

    api.sidebar.item({ id: "focus-timer", label: "Focus timer", pageId: PAGE_ID, icon: "gauge" })

    api.pages.register({
      id: PAGE_ID,
      path: "/focus-timer",
      title: "Focus timer",
      surface(channel) {
        const { surfaceId } = channel
        let shape = { tasks: state.tasks.length > 0, log: state.log.length > 0 }
        let interval: ReturnType<typeof setInterval> | undefined
        let noticeShown = false

        const notify = (notice: Notice | null) => {
          channel.send(...noticeMessages(surfaceId, notice, noticeShown))
          noticeShown = notice !== null
        }

        const render = () => {
          const now = Date.now()
          const next = { tasks: state.tasks.length > 0, log: state.log.length > 0 }
          const swapped = [
            ...(next.tasks !== shape.tasks ? [tasksBody(next.tasks)] : []),
            ...(next.log !== shape.log ? [logBody(next.log)] : []),
          ]
          shape = next
          channel.send(...(swapped.length > 0 ? [components(surfaceId, swapped)] : []), ...stateMessages(surfaceId, state, now))
        }

        const syncTicking = () => {
          if (state.timer.status === "running" && interval === undefined) interval = setInterval(onTick, 1000)
          if (state.timer.status !== "running" && interval !== undefined) {
            clearInterval(interval)
            interval = undefined
          }
        }

        const onTick = () => {
          const now = Date.now()
          const result = tick(state, now)
          if (result.state.timer.mode === state.timer.mode && result.state.timer.status === state.timer.status) {
            state = result.state
            channel.send(patch(surfaceId, "/remaining", remainingData(state, now)))
            return
          }
          commit(result.state, result.finished)
        }

        const listener = (finished: LogEntry | null) => {
          render()
          syncTicking()
          if (finished?.outcome === "completed") {
            api.ui.toast({
              kind: "success",
              title: `${MODE_LABEL[finished.mode]} finished`,
              description: `Up next: ${MODE_LABEL[state.timer.mode]} (${formatClock(state.timer.blockSeconds)})`,
            })
          }
        }
        listeners.add(listener)

        channel.send(...openMessages(surfaceId, state, Date.now()))
        syncTicking()

        const withSettings = (action: SurfaceActionEvent): FocusState =>
          "settings" in action.context ? applySettings(state, readSettings(action.context.settings, state.settings)) : state

        return {
          async action(action) {
            const now = Date.now()
            const current = withSettings(action)
            switch (action.name) {
              case "start":
                commit(start(current, now))
                return
              case "pause":
                commit(pause(current, now))
                return
              case "skip": {
                const result = skip(current, now)
                commit(result.state, result.finished)
                return
              }
              case "reset":
                commit(reset(current))
                return
              case "switchMode": {
                const mode = action.context.mode
                const picked = Array.isArray(mode) ? mode[0] : undefined
                if (!isMode(picked)) {
                  api.ui.toast({ kind: "warning", title: "Pick a mode first" })
                  return
                }
                if (current.timer.status === "running") {
                  const ok = await api.ui.confirm({
                    title: `Switch to ${MODE_LABEL[picked]}?`,
                    description: "The running block stops without being logged.",
                    confirmLabel: "Switch",
                  })
                  if (!ok) {
                    channel.send(patch(surfaceId, "/modeChoice", [state.timer.mode]))
                    return
                  }
                }
                commit(switchMode(withSettings(action), picked))
                return
              }
              case "applySettings":
                commit(current)
                api.ui.toast({ kind: "info", title: "Settings applied", description: current.timer.status === "idle" ? undefined : "Durations apply from the next block." })
                return
              case "addTask": {
                const change = addTask(current, contextText(action, "title"), action.context.estimate)
                if (change.error) {
                  notify({ title: "Task not added", text: change.error })
                  return
                }
                notify(null)
                commit(change.state)
                channel.send(patch(surfaceId, "/draft", { title: "", estimate: "1" }))
                return
              }
              case "selectTask":
                commit(selectTask(current, contextText(action, "id")))
                return
              case "toggleTask":
                commit(toggleTaskDone(current, contextText(action, "id")))
                return
              case "removeTask": {
                const ok = await api.ui.confirm({ title: `Remove "${contextText(action, "title")}"?`, confirmLabel: "Remove task" })
                if (ok) commit(removeTask(state, contextText(action, "id")))
                return
              }
            }
          },
          dispose() {
            listeners.delete(listener)
            if (interval !== undefined) clearInterval(interval)
            interval = undefined
          },
        }
      },
    })

    api.commands.register({
      id: "focus-timer.open",
      title: "Open focus timer",
      category: "Focus timer",
      run: () => api.pages.open(PAGE_ID),
    })

    api.commands.register({
      id: "focus-timer.toggle",
      title: "Start or pause the focus timer",
      category: "Focus timer",
      run: () => {
        const now = Date.now()
        const result = tick(state, now)
        commit(toggle(result.state, now), result.finished)
        api.ui.toast({
          kind: "info",
          title: state.timer.status === "running" ? `${MODE_LABEL[state.timer.mode]} running` : "Timer paused",
          description: formatClock(state.timer.remainingSeconds),
        })
      },
    })
  },
})
