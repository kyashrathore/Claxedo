/**
 * ProcessPane
 *
 * Bottom panel showing all configured processes as side-by-side terminal panels
 * in a horizontal strip. The pane sits below the GroupContentRenderer area.
 *
 * Features:
 * - Top edge drag handle for pane height resize (pointer tracking)
 * - Header: "Processes" label, scroll [<][>], "Start All"/"Stop All", "+ Add"
 * - Terminal strip: horizontal flex with overflow-x: hidden, one ProcessPanePanel per config
 * - Scroll: effect watches scrollIndex, calls containerRef.scrollTo({ left, behavior: "smooth" })
 * - Pane visibility: CSS hidden class (NOT <Show>) toggled via useProcessPane().toggle()
 *
 * CRITICAL: Never use <Show> to toggle expensive panels. Use CSS hidden class.
 * All terminals stay mounted in the DOM at all times.
 */

import { For, Show, createEffect, createMemo, createSignal, on, onMount, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { getFilename } from "@opencode-ai/util/path"
import { useProcessPane } from "../context/process-pane"
import { ProcessPanePanel } from "./process-pane-panel"
import { AddProcessDialog } from "./add-process-dialog"

const MIN_PANE_HEIGHT = 120
const MAX_PANE_HEIGHT = 800
const MIN_PANEL_WIDTH_PX = 200

export function ProcessPane() {
  const pp = useProcessPane()
  const sdk = useSDK()
  const dialog = useDialog()
  const dirName = createMemo(() => getFilename(sdk.directory) || sdk.directory)
  let scrollContainerRef!: HTMLDivElement
  let stripRef!: HTMLDivElement

  // Helper to open the add/edit dialog
  const openAddDialog = (editConfig?: Parameters<typeof AddProcessDialog>[0]["config"]) => {
    dialog.show(() => (
      <AddProcessDialog
        config={editConfig}
        onDone={() => pp.refresh()}
        onCreated={() => {
          // Just open the pane — the new panel shows "Process not running"
          // with a Start button. User starts manually when ready.
          if (!pp.isOpen()) pp.toggle()
        }}
      />
    ))
  }

  // --- Keyboard shortcuts ---
  // mod+shift+[ / mod+shift+] to navigate panes
  onMount(() => {
    const handle = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (!event.shiftKey) return
      if (event.key === "[") {
        event.preventDefault()
        pp.scrollLeft()
      } else if (event.key === "]") {
        event.preventDefault()
        pp.scrollRight()
      }
    }
    window.addEventListener("keydown", handle)
    onCleanup(() => window.removeEventListener("keydown", handle))
  })

  // --- Height resize drag handle ---
  const [dragging, setDragging] = createSignal(false)

  const handleHeightDragStart = (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = pp.paneHeight()

    const move = (e: PointerEvent) => {
      // Dragging upward increases height (pane grows from bottom)
      const delta = startY - e.clientY
      const next = Math.max(MIN_PANE_HEIGHT, Math.min(MAX_PANE_HEIGHT, startHeight + delta))
      pp.setPaneHeight(next)
    }

    const up = () => {
      setDragging(false)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.dispatchEvent(new Event("opencode:terminal-fit"))
    }

    setDragging(true)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // --- Panel width resize ---
  // Between two panels: dragging adjusts both widths (left grows ↔ right shrinks).
  // On the last panel's right edge: dragging adjusts only that panel's width.
  const handlePanelResizeStart = (index: number, event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const widths = pp.paneWidths()
    const isLast = index === configs().length - 1
    const startWidth = widths[index] ?? 400
    const startRightWidth = !isLast ? (widths[index + 1] ?? 400) : 0

    const move = (e: PointerEvent) => {
      const delta = e.clientX - startX

      if (isLast) {
        // Last panel: just resize itself
        pp.setPaneWidth(index, Math.max(MIN_PANEL_WIDTH_PX, startWidth + delta))
      } else {
        // Between two panels: adjust both
        const newLeft = Math.max(MIN_PANEL_WIDTH_PX, startWidth + delta)
        const newRight = Math.max(MIN_PANEL_WIDTH_PX, startRightWidth - delta)
        if (newLeft === MIN_PANEL_WIDTH_PX || newRight === MIN_PANEL_WIDTH_PX) {
          const clampedDelta = newRight === MIN_PANEL_WIDTH_PX
            ? startRightWidth - MIN_PANEL_WIDTH_PX
            : -(startWidth - MIN_PANEL_WIDTH_PX)
          pp.setPaneWidth(index, Math.max(MIN_PANEL_WIDTH_PX, startWidth + clampedDelta))
          pp.setPaneWidth(index + 1, Math.max(MIN_PANEL_WIDTH_PX, startRightWidth - clampedDelta))
        } else {
          pp.setPaneWidth(index, newLeft)
          pp.setPaneWidth(index + 1, newRight)
        }
      }
    }

    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.dispatchEvent(new Event("opencode:terminal-fit"))
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // --- Scroll navigation ---
  const configs = createMemo(() => pp.configs())
  const scrollIndex = createMemo(() => pp.scrollIndex())
  const canScrollLeft = createMemo(() => scrollIndex() > 0)
  const canScrollRight = createMemo(() => scrollIndex() < configs().length - 1)

  createEffect(
    on([scrollIndex, configs, () => pp.paneWidths()], () => {
      if (!scrollContainerRef || !stripRef) return
      const total = configs().length
      if (total === 0) return
      const widths = pp.paneWidths()
      const idx = scrollIndex()
      // Sum pixel widths of panels before the scroll target
      const left = widths.slice(0, idx).reduce((s, w) => s + (w ?? 400), 0)
      scrollContainerRef.scrollTo({ left, behavior: "smooth" })
    }),
  )

  return (
    <div
      data-component="process-pane"
      class="absolute bottom-0 left-0 right-0 z-[60] flex flex-col border-t border-border-weak-base bg-background-base overflow-hidden"
      classList={{ hidden: !pp.isOpen() }}
      style={{ height: `${pp.paneHeight()}px` }}
    >
      {/* Top edge drag handle for height resize */}
      <div
        class="h-[4px] shrink-0 cursor-row-resize transition-colors hover:bg-blue-500/30"
        classList={{ "bg-blue-500/30": dragging() }}
        onPointerDown={handleHeightDragStart}
      />

      {/* Header row */}
      <div class="shrink-0 h-8 flex items-center gap-2 px-3 border-b border-border-weak-base bg-background-stronger/60 select-none">
        {/* Label */}
        <span class="text-[12px] font-semibold text-text-weak">Processes</span>
        <span class="text-[11px] font-medium text-text-weak/60 truncate max-w-[200px]" title={sdk.directory}>
          {dirName()}
        </span>

        <div class="flex items-center gap-0.5 ml-auto">
          {/* Scroll buttons — only show when there are 2+ configs */}
          <Show when={configs().length > 1}>
            <Tooltip value="Scroll left (Cmd+Shift+[)">
              <IconButton
                icon="arrow-left"
                variant="ghost"
                onClick={() => pp.scrollLeft()}
                disabled={!canScrollLeft()}
                aria-label="Scroll left"
              />
            </Tooltip>
            <Tooltip value="Scroll right (Cmd+Shift+])">
              <IconButton
                icon="chevron-right"
                variant="ghost"
                onClick={() => pp.scrollRight()}
                disabled={!canScrollRight()}
                aria-label="Scroll right"
              />
            </Tooltip>
          </Show>

          {/* Bulk actions — only show when there are configs */}
          <Show when={configs().length > 0}>
            <div class="w-px h-4 bg-border-weak-base" />
            <Tooltip value="Start all processes">
              <button
                type="button"
                class="text-[11px] font-medium px-1.5 py-0.5 rounded transition-colors"
                classList={{
                  "text-text-weak hover:text-text-base hover:bg-surface-base-hover": !pp.hasStopping(),
                  "text-text-weak/40 cursor-default": pp.hasStopping(),
                }}
                disabled={pp.hasStopping()}
                onClick={() => pp.startAll()}
              >
                Start All
              </button>
            </Tooltip>
            <Tooltip value="Stop all processes">
              <button
                type="button"
                class="text-[11px] font-medium px-1.5 py-0.5 rounded transition-colors"
                classList={{
                  "text-text-weak hover:text-text-base hover:bg-surface-base-hover": pp.hasRunning() || pp.hasStopping(),
                  "text-text-weak/40 cursor-default": !pp.hasRunning() && !pp.hasStopping(),
                }}
                disabled={!pp.hasRunning() && !pp.hasStopping()}
                onClick={() => pp.stopAll()}
              >
                Stop All
              </button>
            </Tooltip>
          </Show>

          {/* Separator */}
          <div class="w-px h-4 bg-border-weak-base" />

          {/* Add button */}
          <Tooltip value="Add process">
            <IconButton
              icon="plus-small"
              variant="ghost"
              onClick={() => openAddDialog()}
              aria-label="Add process"
            />
          </Tooltip>

          {/* Minimize pane */}
          <Tooltip value="Minimize process pane">
            <IconButton
              icon="chevron-down"
              variant="ghost"
              onClick={pp.toggle}
              aria-label="Minimize process pane"
            />
          </Tooltip>
        </div>
      </div>

      {/* Terminal strip: scroll container with inner strip so panes are scrollable */}
      <div
        ref={(el) => { scrollContainerRef = el }}
        class="flex-1 min-h-0 overflow-x-auto"
      >
        <div
          ref={(el) => { stripRef = el }}
          class="flex h-full"
        >
        <Show
          when={configs().length > 0}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center gap-3 text-text-weak">
              <Icon name="console" size="medium" />
              <span class="text-[12px]">No processes configured</span>
              <button
                type="button"
                class="px-3 py-1.5 rounded text-[12px] font-medium bg-surface-base-hover hover:bg-surface-base-active text-text-base transition-colors"
                onClick={() => openAddDialog()}
              >
                Add Process
              </button>
            </div>
          }
        >
          <For each={configs()}>
            {(config, index) => {
              const widthPx = createMemo(() => {
                const widths = pp.paneWidths()
                return widths[index()] ?? 400
              })

              return (
                <div
                  class="shrink-0 h-full relative overflow-hidden border-l border-border-weaker-base last:border-r last:border-r-border-weaker-base"
                  style={{ width: `${widthPx()}px` }}
                >
                  <ProcessPanePanel
                    config={config}
                    process={pp.processForConfig(config.id)}
                    isLast={index() === configs().length - 1}
                    onStart={() => pp.start(config.id)}
                    onStop={() => pp.stop(config.id)}
                    onRestart={() => pp.restart(config.id)}
                    onEdit={() => openAddDialog(config)}
                    onResizeStart={(e) => handlePanelResizeStart(index(), e)}
                  />
                </div>
              )
            }}
          </For>
        </Show>
        </div>
      </div>
    </div>
  )
}
