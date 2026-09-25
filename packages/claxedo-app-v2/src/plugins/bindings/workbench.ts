import { createEffect, createRoot, on } from "solid-js"
import type { WorkbenchApi, WorkbenchTab, WorkbenchTabStatus } from "@claxedo/plugin-api"
import type { SessionRowView } from "@/session"
import { PluginEntryError, type BindingScope } from "./services"

function statusOf(row: SessionRowView | undefined): WorkbenchTabStatus {
  if (!row) return "idle"
  if (row.waitingOnUser) return "attention"
  switch (row.status.kind) {
    case "working":
    case "retrying":
    case "recovering":
      return "working"
    case "failed":
      return "failed"
    case "idle":
    case "unknown":
      return "idle"
  }
}

function openTabs(scope: BindingScope): readonly WorkbenchTab[] {
  const { workbench, sessions } = scope.services
  const focused = workbench.selectors.focusedContent()
  const tabs = workbench.selectors.aliveContents().flatMap((contentId) => {
    const opened = workbench.content(contentId)
    if (!opened) return []
    const route = workbench.routeOf(contentId)
    const row = route?.kind === "session" ? sessions.list.view(route.sessionId) : undefined
    return [{ id: contentId, title: opened.kind.title(opened.state as never), kind: opened.kind.kind, status: statusOf(row), active: focused === contentId }]
  })
  return tabs.map((tab, index) => ({ ...tab, index }))
}

export function workbenchBinding(scope: BindingScope): WorkbenchApi {
  const { workbench } = scope.services
  const tabs = () => openTabs(scope)
  return {
    tabs,
    activate: (tabId) => workbench.navigation.show(tabId),
    close: (tabId) => workbench.closeContent(tabId),
    move: () => {
      throw new PluginEntryError(scope.manifest.id, "the workbench cannot reorder tabs yet")
    },
    onChanged: (listener) =>
      scope.sink.track(
        createRoot((dispose) => {
          createEffect(on(tabs, (current) => listener(current), { defer: true }))
          return dispose
        }),
      ),
  }
}
