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

export function GroupContentRenderer(props: { groupId: string; renderEmpty?: () => JSX.Element }) {
  const claxedo = useClaxedoLayout()
  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))

  const activeTab = createMemo(() => claxedo.select.groupActiveTab(props.groupId))

  // Track which tab IDs have been mounted (activated at least once).
  // These tabs stay in the DOM even when inactive, hidden via CSS.
  const [mounted, setMounted] = createSignal<string[]>([])

  // Mounted-tab retention policy (track active tabs, prune closed tabs).
  //
  // Two phases:
  // 1. SYNC — ensure the newly-active tab is in mounted immediately so its
  //    component tree renders in the current frame.
  // 2. DEFERRED — prune closed tabs via queueMicrotask.  Deferring avoids
  //    disposing a complex component tree (SDKProvider → ProcessPaneProvider →
  //    Terminal) during the same synchronous batch flush that removed the tab
  //    from items.  SolidJS's cleanNode can crash when the disposal cascade
  //    overlaps with a still-flushing reactive graph (the "Cannot read
  //    properties of null (reading '0')" TypeError).
  createEffect(
    on(
      () => [activeTab()?.id, tabs().items()] as const,
      ([activeId, _items]) => {
        // Phase 1 (sync): mount the new active tab immediately
        if (activeId) {
          setMounted((prev) =>
            prev.includes(activeId) ? prev : [...prev, activeId],
          )
        }

        // Phase 2 (deferred): prune dead tabs after the batch settles.
        // Read fresh values inside the microtask so rapid successive closes
        // always see the latest state.
        queueMicrotask(() => {
          const currentItems = tabs().items()
          const currentActiveId = activeTab()?.id
          const liveIds = new Set(currentItems.map((tab) => tab.id))
          setMounted((prev) => {
            const next = retainMountedTabsPolicy({
              mounted: prev,
              activeId: currentActiveId,
              liveIds,
            })
            const changed = next.length !== prev.length || next.some((id, i) => id !== prev[i])
            return changed ? next : prev
          })
        })
      },
    ),
  )

  return (
    <GroupLayoutProvider groupId={props.groupId}>
      <div class="relative flex-1 min-h-0 h-full">
        <Show when={!activeTab() && props.renderEmpty} keyed>
          {(render) => (
            <div class="absolute inset-0 flex flex-col items-center justify-center p-8 text-center text-text-weak">
              {render()}
            </div>
          )}
        </Show>
        <For each={mounted()}>
          {(tabId) => {
            const isActive = createMemo(() => activeTab()?.id === tabId)

            return (
              <div class="absolute inset-0 overflow-hidden" classList={{ hidden: !isActive() }}>
                <MultiPaneTab tabId={tabId} groupId={props.groupId} />
              </div>
            )
          }}
        </For>
      </div>
    </GroupLayoutProvider>
  )
}
