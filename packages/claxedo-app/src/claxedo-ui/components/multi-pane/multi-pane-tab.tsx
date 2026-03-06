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
import { processSessionLayout, reviewSessionLayout } from "../../context/claxedo-layout/multi-pane"
import { GenericFlatPaneRenderer } from "./generic-flat-pane-renderer"
import { ProcessPaneProvider } from "../../context/process-pane"
import { SDKProvider } from "@/context/sdk"
import { createDebugLogger } from "../../../overrides/utils/debug"

export function MultiPaneTab(props: { tabId: string; groupId: string }) {
  const claxedo = useClaxedoLayout()
  const debug = createDebugLogger("layout.process", "layout:process", {
    legacyKey: "opencode.debug.terminal",
  })
  const state = createMemo(() => claxedo.multiPane.getState(props.tabId))
  const tab = createMemo(() => {
    const tabs = claxedo.groupTabs(props.groupId)
    return tabs.items().find((t) => t.id === props.tabId)
  })

  // Determine if this tab is a process tab
  const isProcessTab = createMemo(() => tab()?.type === "process")

  const processDirectory = createMemo(() => {
    const dir = tab()?.directory ?? ""
    // "__process__" is a placeholder used before a real worktree default is set — not a valid path
    if (!dir || dir === "__process__") return ""
    return dir
  })

  createEffect(
    on(
      () => [props.groupId, props.tabId, tab()?.type, tab()?.directory, !!state(), processDirectory()] as const,
      ([groupId, tabId, type, dir, ready, processDir]) => {
        if (type !== "process") return
        if (!ready) {
          debug.log("tab spinner", {
            groupId,
            tabId,
            type,
            dir: dir ?? null,
            processDir: processDir || null,
            reason: "missing-multi-pane-state",
          })
          return
        }
        if (processDir) {
          debug.verbose("tab ready", {
            groupId,
            tabId,
            dir: processDir,
          })
          return
        }
        debug.log("tab spinner", {
          groupId,
          tabId,
          type,
          dir: dir ?? null,
          processDir: null,
          reason: "invalid-process-directory",
        })
      },
      { defer: true },
    ),
  )

  // Lazy-initialize multi-pane state for persisted tabs that don't have it yet
  createEffect(
    on(
      () => [props.tabId, state()] as const,
      ([tabId, s]) => {
        if (s) return
        // Use props.groupId directly (more reliable than findTabGroup which can fail on timing)
        const groupId = props.groupId || claxedo.findTabGroup(tabId)
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
        if (tab.type === "review-workspace" && tab.directory && tab.sessionId) {
          claxedo.multiPane.initTab(
            tabId,
            tab.directory,
            reviewSessionLayout({
              directory: tab.directory,
              sessionId: tab.sessionId,
              reviewMode: tab.reviewMode,
              reviewFromRef: tab.reviewFromRef,
              reviewToRef: tab.reviewToRef,
            }),
          )
          return
        }
        if (tab.type === "process" && tab.directory) {
          debug.verbose("init process tab", {
            groupId,
            tabId,
            dir: tab.directory,
          })
          claxedo.multiPane.initTab(
            tabId,
            tab.directory,
            processSessionLayout({ directory: tab.directory }),
          )
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

  const paneRenderer = () => (
    <div class="relative flex-1 min-h-0">
      <GenericFlatPaneRenderer tabId={props.tabId} groupId={props.groupId} />
    </div>
  )

  return (
    <div class="flex flex-col h-full">
      <Show when={state()}>
        <Show
          when={isProcessTab()}
          fallback={paneRenderer()}
        >
          <Show
            when={processDirectory()}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak">
                <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
              </div>
            }
          >
            <SDKProvider directory={() => processDirectory()}>
              <ProcessPaneProvider tabId={props.tabId}>
                {paneRenderer()}
              </ProcessPaneProvider>
            </SDKProvider>
          </Show>
        </Show>
      </Show>
      <Show when={!state()}>
        <div class="flex items-center justify-center h-full text-text-weak">
          <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
        </div>
      </Show>
    </div>
  )
}
