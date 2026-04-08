/**
 * MultiPaneTab
 *
 * Main component for a multi-pane tab.
 *
 * Every tab type is now rendered through MultiPaneTab. Tabs without
 * multi-pane state get lazy-initialized on first render.
 */

import { Show, createMemo, createEffect, on, onMount, onCleanup } from "solid-js"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { processSessionLayout, reviewSessionLayout } from "../../context/claxedo-layout/multi-pane"
import { isGlobalTab } from "../../context/claxedo-layout/types"
import { GenericFlatPaneRenderer } from "./generic-flat-pane-renderer"
import { ProcessPaneProvider } from "../../context/process-pane"
import { createDebugLogger } from "../../../overrides/utils/debug"
import { WorkspaceSDKProvider } from "../workspace-sdk-provider"

export function MultiPaneTab(props: { tabId: string; groupId: string; scrollable?: boolean; minPaneWidth?: number }) {
  const claxedo = useClaxedoLayout()
  const debug = createDebugLogger("layout.process", "layout:process", {
    legacyKey: "opencode.debug.terminal",
  })
  const inst = Math.random().toString(36).slice(2, 7)
  const state = createMemo(() => claxedo.multiPane.getState(props.tabId))
  const active = createMemo(() => claxedo.groupTabs(props.groupId).activeId() === props.tabId)
  const tab = createMemo(() => {
    const tabs = claxedo.groupTabs(props.groupId)
    return tabs.items().find((t) => t.id === props.tabId)
  })
  const kind = createMemo<NonNullable<ReturnType<typeof tab>>["type"] | null>((prev) => tab()?.type ?? prev ?? null, null)
  const hasProcess = createMemo(() =>
    claxedo.select.multiPaneLeafView(props.tabId).some((leaf) => leaf.content?.type === "process"),
  )
  const dir = createMemo<string>((prev) => {
    const live = tab()?.directory
    if (live && live !== "__process__") return live
    const leaf = claxedo.select.multiPaneLeafView(props.tabId).find((item) => item.content?.type === "process")
    const next = leaf?.content?.directory
    if (next && next !== "__process__") return next
    return prev ?? ""
  }, "")
  const snap = () => ({
    inst,
    groupId: props.groupId,
    tabId: props.tabId,
    liveType: tab()?.type ?? null,
    liveDir: tab()?.directory ?? null,
    kind: kind(),
    hasTab: !!tab(),
    hasState: !!state(),
    processDir: dir() || null,
    activeId: claxedo.groupTabs(props.groupId).activeId() ?? null,
    leaves: claxedo.select.multiPaneLeafView(props.tabId).map((leaf) => ({
      id: leaf.id,
      type: leaf.content?.type ?? null,
      processId: leaf.content?.type === "process" ? (leaf.content.processId ?? null) : null,
    })),
  })

  onMount(() => {
    debug.verbose("multi-pane mount", snap())
  })

  onCleanup(() => {
    debug.log("multi-pane cleanup", snap())
    queueMicrotask(() => {
      debug.verbose("multi-pane cleanup settled", snap())
    })
  })

  createEffect(
    on(
      () => [props.groupId, props.tabId, kind(), tab()?.directory, !!state(), dir()] as const,
      ([groupId, tabId, type, liveDir, ready, processDir]) => {
        if (type !== "process") return
        if (!ready) {
          debug.log("tab spinner", {
            groupId,
            tabId,
            type,
            dir: liveDir ?? null,
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
          dir: liveDir ?? null,
          processDir: null,
          reason: "invalid-process-directory",
        })
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () =>
        [
          !!state(),
          kind() === "process",
          dir(),
          tab()?.id ?? null,
          tab()?.type ?? null,
          tab()?.directory ?? null,
        ] as const,
      ([ready, isProcess, dir, id, type, tabDir], prev) => {
        debug.verbose("tab branch", {
          inst,
          prev: prev
            ? {
              ready: prev[0],
              isProcess: prev[1],
              dir: prev[2] || null,
              id: prev[3],
              type: prev[4],
              tabDir: prev[5],
            }
            : null,
          next: {
            ready,
            isProcess,
            dir: dir || null,
            id,
            type,
            tabDir,
          },
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
        if (tab.type === "multi-pane") {
          claxedo.multiPane.initTab(tabId, tab.directory)
          return
        }
        if (tab.type === "page" && tab.pageId && !isGlobalTab(tab) && tab.directory) {
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
        if (tab.type === "page") {
          claxedo.multiPane.initTabWithContent(tabId, {
            type: "page",
            ...(tab.directory ? { directory: tab.directory } : {}),
            pageId: tab.pageId!,
            sessionId: tab.sessionId,
            filePath: tab.filePath,
            title: tab.title,
          })
          return
        }
        if (tab.type === "pages-index" || tab.type === "workgraph") {
          claxedo.multiPane.initTabWithContent(tabId, {
            type: tab.type,
            ...(tab.directory ? { directory: tab.directory } : {}),
            title: tab.title,
          })
          return
        }
        claxedo.multiPane.initTabWithContent(tabId, {
          type: tab.type,
          directory: tab.directory!,
          sessionId: tab.sessionId,
          terminalId: tab.terminalId,
          filePath: tab.filePath,
          title: tab.title,
          reviewMode: tab.reviewMode,
          reviewFromRef: tab.reviewFromRef,
          reviewToRef: tab.reviewToRef,
        })
      },
    ),
  )

  const paneRenderer = () => (
    <div class="relative flex-1 min-h-0 max-w-full" classList={{ "w-fit min-w-full": !!props.scrollable }}>
      <GenericFlatPaneRenderer tabId={props.tabId} groupId={props.groupId} active={active()} scrollable={props.scrollable} minPaneWidth={props.minPaneWidth} />
    </div>
  )

  return (
    <div class="flex flex-col h-full">
      <Show when={state()}>
        <Show
          when={hasProcess()}
          fallback={paneRenderer()}
        >
          <Show
            when={dir()}
            fallback={
              <div class="flex items-center justify-center h-full text-text-weak">
                <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
              </div>
            }
          >
            <WorkspaceSDKProvider directory={() => dir()}>
              <ProcessPaneProvider tabId={props.tabId}>
                {paneRenderer()}
              </ProcessPaneProvider>
            </WorkspaceSDKProvider>
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
