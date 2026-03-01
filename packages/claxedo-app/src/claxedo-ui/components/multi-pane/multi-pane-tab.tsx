/**
 * MultiPaneTab
 *
 * Main component for a multi-pane tab.
 *
 * Every tab type is now rendered through MultiPaneTab. Tabs without
 * multi-pane state get lazy-initialized on first render.
 */

import { Show, createMemo, createEffect, on } from "solid-js"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { GenericFlatPaneRenderer } from "./generic-flat-pane-renderer"

export function MultiPaneTab(props: { tabId: string; groupId: string }) {
  const claxedo = useClaxedoLayout()
  const state = createMemo(() => claxedo.multiPane.getState(props.tabId))

  // Lazy-initialize multi-pane state for persisted tabs that don't have it yet
  createEffect(
    on(
      () => [props.tabId, state()] as const,
      ([tabId, s]) => {
        if (s) return
        // Find the tab to get its content info
        const groupId = claxedo.findTabGroup(tabId)
        if (!groupId) return
        const tabs = claxedo.groupTabs(groupId)
        const tab = tabs.items().find((t) => t.id === tabId)
        if (!tab) return
        if (tab.type === "page" && tab.pageId && tab.directory && tab.directory !== "__pages__") {
          claxedo.multiPane.initPageSessionTab(tabId, {
            directory: tab.directory,
            pageId: tab.pageId,
            title: tab.title,
          })
          return
        }
        claxedo.multiPane.initTabWithContent(tabId, {
          type: tab.type,
          directory: tab.directory,
          sessionId: tab.sessionId,
          terminalId: tab.terminalId,
          filePath: tab.filePath,
          pageId: tab.pageId,
          title: tab.title,
          reviewMode: tab.reviewMode,
          reviewFromRef: tab.reviewFromRef,
          reviewToRef: tab.reviewToRef,
        })
      },
    ),
  )

  return (
    <div class="flex flex-col h-full">
      <Show when={state()}>
        <div class="relative flex-1 min-h-0">
          <GenericFlatPaneRenderer tabId={props.tabId} groupId={props.groupId} />
        </div>
      </Show>
      <Show when={!state()}>
        <div class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      </Show>
    </div>
  )
}
