/**
 * GroupContentRenderer
 *
 * Renders content for a specific group panel based on its active tab.
 * Each group gets its own DirectoryScope + SessionParamsProvider,
 * allowing multiple sessions to render simultaneously in split mode.
 *
 * Uses CSS visibility caching: previously-rendered tabs stay mounted in
 * the DOM and are hidden with `display: none` instead of being destroyed.
 * This avoids re-creating the expensive provider chain (DirectoryScope
 * with 8 nested providers + SessionPage) on every tab switch.
 */

import { Show, For, createMemo, createSignal, createEffect, on, type JSX } from "solid-js"
import { useClaxedoLayout } from "../context/claxedo-layout"
import { GroupLayoutProvider } from "./group-layout-provider"
import { MultiPaneTab } from "./multi-pane/multi-pane-tab"
import { retainMountedTabsPolicy } from "./retain-mounted-tabs-policy"
import { createDebugLogger } from "../../overrides/utils/debug"

export function GroupContentRenderer(props: { groupId: string; renderEmpty?: () => JSX.Element }) {
  const claxedo = useClaxedoLayout()
  const debug = createDebugLogger("layout.group-render", "layout:group-render", {
    legacyKey: "opencode.debug.terminal",
  })
  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))
  const wt = claxedo.groupWorktree(props.groupId)

  const activeTab = createMemo(() => claxedo.select.groupActiveTab(props.groupId))

  // Track which tab IDs have been mounted (activated at least once).
  // These tabs stay in the DOM even when inactive, hidden via CSS.
  const [mounted, setMounted] = createSignal<string[]>([])

  createEffect(
    on(
      () =>
        [
          props.groupId,
          wt.default(),
          wt.pinned(),
          tabs().activeId(),
          tabs().active()?.directory,
          activeTab()?.id,
          activeTab()?.type,
          activeTab()?.directory,
          tabs().items().length,
        ] as const,
      ([groupId, defaultDir, pinnedDir, activeId, activeDir, resolvedId, resolvedType, resolvedDir, count]) => {
        debug.log("tab selection", {
          groupId,
          defaultDir,
          pinnedDir,
          activeId,
          activeDir,
          resolvedId,
          resolvedType,
          resolvedDir,
          tabCount: count,
        })
      },
      { defer: true },
    ),
  )

  // Mounted-tab retention policy (track active tabs, prune closed tabs).
  createEffect(
    on(
      () => [activeTab()?.id, tabs().items()] as const,
      ([activeId, items]) => {
        const liveIds = new Set(items.map((tab) => tab.id))
        setMounted((prev) => {
          const next = retainMountedTabsPolicy({
            mounted: prev,
            activeId,
            liveIds,
          })
          if (next.length !== prev.length) {
            debug.verbose("prune mounted tabs", {
              groupId: props.groupId,
              before: prev,
              after: next,
              live: items.map((tab) => tab.id),
            })
          }
          return next.length === prev.length ? prev : next
        })
      },
    ),
  )

  return (
    <GroupLayoutProvider groupId={props.groupId}>
      <div class="relative flex-1 min-h-0 h-full">
        <Show when={!activeTab() && props.renderEmpty}>
          {(render) => (
            <div class="absolute inset-0 flex flex-col items-center justify-center p-8 text-center text-text-weak">
              {render()()}
            </div>
          )}
        </Show>
        <For each={mounted()}>
          {(tabId) => {
            const tab = createMemo(() =>
              tabs()
                .items()
                .find((t) => t.id === tabId),
            )
            const isActive = createMemo(() => activeTab()?.id === tabId)
            createEffect(() => {
              const t = tab()
              if (!t) return
              if (!isActive()) return
              debug.log("render active", {
                groupId: props.groupId,
                tabId: t.id,
                type: t.type,
                directory: t.directory,
                sessionId: t.sessionId,
                filePath: t.filePath,
                terminalId: t.terminalId,
              })
            })

            return (
              <Show when={tab()}>
                {(t) => (
                  <div class="absolute inset-0 overflow-hidden" classList={{ hidden: !isActive() }}>
                    <MultiPaneTab tabId={t().id} groupId={props.groupId} />
                  </div>
                )}
              </Show>
            )
          }}
        </For>
      </div>
    </GroupLayoutProvider>
  )
}
