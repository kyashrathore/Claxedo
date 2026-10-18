import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceProgram, type WorkbenchTab } from "@claxedo/plugin-api"
import {
  ALL_TABS,
  appendActivity,
  monitorView,
  moveTarget,
  readFilter,
  tabChanges,
  viewPatches,
  type ActivityEntry,
  type Direction,
  type Filter,
  type Json,
} from "./model"
import { activityArea, monitorComponents, monitorData, openingMessages, patch, replace, tabsArea } from "./view"

const PAGE_ID = "workbench-monitor"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clockTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function openMonitor(api: PluginApi, channel: SurfaceChannel): SurfaceProgram {
  const { surfaceId } = channel
  let tabs: readonly WorkbenchTab[] = api.workbench.tabs()
  let filter: Filter = ALL_TABS
  let view = monitorView(tabs, filter)
  let activity: ActivityEntry[] = []

  channel.send(...openingMessages(surfaceId, monitorComponents(view.rows.length > 0, activity.length > 0), monitorData(view, activity)))

  const render = () => {
    const next = monitorView(tabs, filter)
    const patches = viewPatches(view, next)
    const areaChanged = (view.rows.length > 0) !== (next.rows.length > 0)
    view = next
    channel.send(...patches.map((entry) => patch(surfaceId, entry.path, entry.value)), ...(areaChanged ? [replace(surfaceId, tabsArea(next.rows.length > 0))] : []))
  }

  const receive = (next: readonly WorkbenchTab[]) => {
    const events = tabChanges(tabs, next)
    tabs = next
    if (events.length > 0) {
      const time = clockTime()
      const appended = appendActivity(activity, events.map((event) => ({ time, event })))
      const first = activity.length === 0
      activity = appended.log
      channel.send(...appended.patches.map((entry) => patch(surfaceId, entry.path, entry.value)), ...(first ? [replace(surfaceId, activityArea(true))] : []))
    }
    render()
  }

  const unsubscribe = api.workbench.onChanged(receive)

  const tabFor = (context: Record<string, Json>) => tabs.find((tab) => tab.id === context.id)

  const move = (context: Record<string, Json>, direction: Direction) => {
    const tab = tabFor(context)
    if (!tab) return
    const target = moveTarget(tabs, tab.id, direction)
    if (target === undefined) {
      api.ui.toast({ kind: "info", title: `“${tab.title || "Untitled"}” is already ${direction === "left" ? "first" : "last"}` })
      return
    }
    try {
      api.workbench.move(tab.id, target)
    } catch (error) {
      api.ui.toast({ kind: "warning", title: "Couldn't move the tab", description: errorMessage(error) })
    }
  }

  const close = async (context: Record<string, Json>) => {
    const tab = tabFor(context)
    if (!tab) return
    const confirmed = await api.ui.confirm({
      title: `Close “${tab.title || "Untitled"}”?`,
      description: tab.status === "working" ? "This tab is still working." : undefined,
      confirmLabel: "Close tab",
    })
    if (!confirmed) return
    try {
      api.workbench.close(tab.id)
      api.ui.toast({ kind: "success", title: `Closed “${tab.title || "Untitled"}”` })
    } catch (error) {
      api.ui.toast({ kind: "error", title: "Couldn't close the tab", description: errorMessage(error) })
    }
  }

  return {
    async action(action) {
      switch (action.name) {
        case "applyFilters":
          filter = readFilter(action.context)
          return render()
        case "resetFilters":
          filter = ALL_TABS
          channel.send(patch(surfaceId, "/statuses", []), patch(surfaceId, "/query", ""), patch(surfaceId, "/sort", ["index"]))
          return render()
        case "refresh":
          return receive(api.workbench.tabs())
        case "activateTab": {
          const tab = tabFor(action.context)
          if (tab) api.workbench.activate(tab.id)
          return
        }
        case "moveLeft":
          return move(action.context, "left")
        case "moveRight":
          return move(action.context, "right")
        case "closeTab":
          return close(action.context)
      }
    },
    dispose() {
      unsubscribe()
    },
  }
}

export default definePlugin({
  activate(api) {
    api.pages.register({ id: PAGE_ID, path: "/workbench-monitor", title: "Workbench monitor", surface: (channel) => openMonitor(api, channel) })
    api.sidebar.item({ id: "workbench-monitor", label: "Workbench monitor", pageId: PAGE_ID })
    api.commands.register({ id: "open", title: "Open workbench monitor", category: "Workbench monitor", run: () => api.pages.open(PAGE_ID) })
  },
})
