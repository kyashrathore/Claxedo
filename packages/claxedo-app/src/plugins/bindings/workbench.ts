import { createEffect, createRoot, on, runWithOwner } from "solid-js"
import type { WorkbenchApi, WorkbenchTab, WorkbenchTabStatus } from "@claxedo/plugin-api"
import { sessionActivity, type SessionActivity, type SessionRowView } from "@/session"
import { PluginEntryError, type BindingScope } from "./services"

const TAB_STATUS: Readonly<Record<SessionActivity, WorkbenchTabStatus>> = {
  waiting: "attention",
  working: "working",
  background: "running_in_background",
  failed: "failed",
  idle: "idle",
}

function tabStatusOf(row: SessionRowView | undefined): WorkbenchTabStatus {
  return row ? TAB_STATUS[sessionActivity(row)] : "idle"
}

function openTabs(scope: BindingScope): readonly WorkbenchTab[] {
  const { workbench, sessions } = scope.services
  const focused = workbench.selectors.focusedContent()
  const tabs = workbench.selectors.aliveContents().flatMap((contentId) => {
    const opened = workbench.content(contentId)
    if (!opened) return []
    const route = workbench.routeOf(contentId)
    const row = route?.kind === "session" ? sessions.list.view(route.sessionId) : undefined
    const title = runWithOwner(scope.services.owner, () => opened.kind.title(opened.state as never)) ?? ""
    return [{ id: contentId, title, kind: opened.kind.kind, status: tabStatusOf(row), active: focused === contentId }]
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
        }, scope.services.owner),
      ),
  }
}
