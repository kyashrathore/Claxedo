import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js"
import type { Pane, PaneRect, WorkbenchState } from "./types"
import { WORKBENCH_DRAG_MIME } from "./types"
import { useWorkbench, useWorkbenchContext } from "./provider"
import { computePaneRects } from "./reducers/tree-helpers"
import { computeDropEdge } from "./drag-drop"
import { matchKey, resolveKeyMap, eventTargetIsEditable } from "./keyboard"
import type { Edge, KeyMap } from "./types"
import { Icon } from "@opencode-ai/ui/icon"

export type PaneCtx = {
  paneId: string
  isFocused: () => boolean
  isVisible: () => boolean
  requestClose: (opts?: { destroyContent: boolean }) => void
  requestFocus: () => void
}

export type WorkbenchProps = {
  renderContent: (contentId: string, ctx: PaneCtx) => JSX.Element
  renderEmpty?: () => JSX.Element
  keyMap?: Partial<KeyMap>
  mountPolicy?: "always" | "active-only"
  maxMountedContents?: number
  mountCapCandidate?: (contentId: string) => boolean
  onFocusChange?: (paneId: string | null, contentId: string | null) => void
  onPaneResize?: (paneId: string, rect: PaneRect) => void
  onContentOpen?: (contentId: string, paneId: string) => void
  onContentClose?: (contentId: string, reason: "user" | "stale") => void
}

type DropTarget = {
  paneId: string
  edge: Edge
}

/**
 * <Workbench> renders the pane tree (split + leaves), drag-drop overlays,
 * resize dividers, keyboard shortcuts, and slot-based content mounting.
 *
 * It is "controlled": state lives in the consumer (via WorkbenchProvider),
 * and Workbench dispatches reducer-derived state changes via useWorkbench.
 */
export function Workbench(props: WorkbenchProps): JSX.Element {
  const wb = useWorkbench()
  const ctx = useWorkbenchContext()
  const mountPolicy = () => props.mountPolicy ?? "always"

  // -- container ref + ResizeObserver
  let rootEl: HTMLDivElement | undefined
  const [containerSize, setContainerSize] = createSignal({ w: 0, h: 0 })
  onMount(() => {
    if (!rootEl) return
    const update = () => {
      const r = rootEl!.getBoundingClientRect()
      setContainerSize({ w: r.width, h: r.height })
    }
    update()
    const ResizeObserverCtor: typeof ResizeObserver | undefined =
      typeof ResizeObserver !== "undefined" ? ResizeObserver : undefined
    if (ResizeObserverCtor) {
      const ro = new ResizeObserverCtor(() => update())
      ro.observe(rootEl)
      onCleanup(() => ro.disconnect())
    }
  })

  // -- focus change callback
  let lastFocus: { paneId: string | null; contentId: string | null } = { paneId: null, contentId: null }
  createEffect(() => {
    const s = ctx.getState()
    const paneId = s.focusedPaneId
    const pane = paneId ? s.panes.find((p) => p.id === paneId) : undefined
    const contentId = pane?.contentId ?? null
    if (lastFocus.paneId !== paneId || lastFocus.contentId !== contentId) {
      lastFocus = { paneId, contentId }
      props.onFocusChange?.(paneId, contentId)
    }
  })

  // -- onContentOpen: track which content is in which pane.
  let lastOpenSig: Map<string, string> = new Map() // contentId → paneId
  createEffect(() => {
    const s = ctx.getState()
    const next = new Map<string, string>()
    for (const p of s.panes) {
      if (p.contentId) next.set(p.contentId, p.id)
    }
    for (const [cid, pid] of next.entries()) {
      const prev = lastOpenSig.get(cid)
      if (prev !== pid) props.onContentOpen?.(cid, pid)
    }
    lastOpenSig = next
  })

  // -- onContentClose: track contentIds removals.
  let lastAlive: Set<string> = new Set()
  createEffect(() => {
    const ids = new Set(ctx.getState().contentIds)
    for (const id of lastAlive) {
      if (!ids.has(id)) props.onContentClose?.(id, "user")
    }
    lastAlive = ids
  })

  // -- onPaneResize: throttle via RAF.
  const rectMemo = createMemo(() => computePaneRects(ctx.getState().split.root))
  let pendingFrame: number | null = null
  let lastEmittedRects: Map<string, PaneRect> = new Map()
  const scheduleResizeEmit = () => {
    if (pendingFrame != null) return
    const raf =
      typeof requestAnimationFrame !== "undefined"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => {
            // as-any: fallback timer handle is used only where RAF returns a numeric frame id.
            return setTimeout(() => cb(performance?.now?.() ?? Date.now()), 16) as unknown as number
          }
    pendingFrame = raf(() => {
      pendingFrame = null
      const rects = rectMemo()
      const cs = containerSize()
      for (const [pid, rf] of rects) {
        const abs: PaneRect = {
          left: rf.left * cs.w,
          top: rf.top * cs.h,
          width: rf.width * cs.w,
          height: rf.height * cs.h,
        }
        const last = lastEmittedRects.get(pid)
        if (
          !last ||
          last.left !== abs.left ||
          last.top !== abs.top ||
          last.width !== abs.width ||
          last.height !== abs.height
        ) {
          lastEmittedRects.set(pid, abs)
          props.onPaneResize?.(pid, abs)
        }
      }
    })
  }
  createEffect(
    on(
      () => [rectMemo(), containerSize()] as const,
      () => scheduleResizeEmit(),
    ),
  )

  // -- keyboard
  const keyMap = createMemo(() => resolveKeyMap(props.keyMap))
  const onKeyDown = (e: KeyboardEvent) => {
    if (eventTargetIsEditable(e.target)) return
    const km = keyMap()
    const s = ctx.getState()
    if (matchKey(e, km.closePane)) {
      e.preventDefault()
      if (s.focusedPaneId) wb.split.close(s.focusedPaneId, { destroyContent: false })
      return
    }
    if (
      matchKey(e, km.focusLeft) ||
      matchKey(e, km.focusRight) ||
      matchKey(e, km.focusUp) ||
      matchKey(e, km.focusDown)
    ) {
      e.preventDefault()
      const direction =
        matchKey(e, km.focusLeft)
          ? "left"
          : matchKey(e, km.focusRight)
            ? "right"
            : matchKey(e, km.focusUp)
              ? "up"
              : "down"
      moveFocusByDirection(direction, ctx.getState(), wb)
    }
  }
  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onKeyDown)
      onCleanup(() => window.removeEventListener("keydown", onKeyDown))
    }
  })

  // -- ESC during drag-over cancels next drop
  const [dragSuppressed, setDragSuppressed] = createSignal(false)
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null)
  const clearDropTarget = () => setDropTarget(null)
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    setDragSuppressed(true)
    clearDropTarget()
  }
  onMount(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", onWindowKey)
      window.addEventListener("dragend", clearDropTarget)
      window.addEventListener("drop", clearDropTarget)
      onCleanup(() => {
        window.removeEventListener("keydown", onWindowKey)
        window.removeEventListener("dragend", clearDropTarget)
        window.removeEventListener("drop", clearDropTarget)
      })
    }
  })

  // -- Per-pane CSS rect (positioned absolutely inside root)
  const paneRectStyle = (paneId: string) => {
    const rects = rectMemo()
    const r = rects.get(paneId)
    if (!r) return { display: "none" }
    return {
      position: "absolute" as const,
      left: `${r.left * 100}%`,
      top: `${r.top * 100}%`,
      width: `${r.width * 100}%`,
      height: `${r.height * 100}%`,
    }
  }

  const contentPaneMap = createMemo(() => {
    const map = new Map<string, string>()
    for (const pane of ctx.getState().panes) {
      if (pane.contentId) map.set(pane.contentId, pane.id)
    }
    return map
  })
  const visibleContentSet = createMemo(() => new Set(contentPaneMap().keys()))
  const isVisibleContent = (contentId: string) => visibleContentSet().has(contentId)
  const paneOfContent = (contentId: string) => contentPaneMap().get(contentId) ?? null

  const aliveForRender = () => {
    const s = ctx.getState()
    const ids = [...new Set([
      ...s.contentIds,
      ...s.panes.map((pane) => pane.contentId).filter((id): id is string => !!id),
    ])]
    if (mountPolicy() === "always") {
      if (!props.maxMountedContents || ids.length <= props.maxMountedContents) return ids
      const visibleIds = ids.filter((id) => visibleContentSet().has(id))
      const alwaysMountedSet = props.mountCapCandidate
        ? new Set(ids.filter((id) => !props.mountCapCandidate?.(id)))
        : new Set<string>()
      const idSet = new Set(ids)
      const visibleCandidateIds = visibleIds.filter((id) => !alwaysMountedSet.has(id))
      const retainedCandidateIds = s.contentRecency
        .filter((id) =>
          idSet.has(id) &&
          !visibleContentSet().has(id) &&
          (!props.mountCapCandidate || props.mountCapCandidate(id))
        )
        .slice(0, Math.max(0, props.maxMountedContents - visibleCandidateIds.length))
      return [...new Set([...visibleIds, ...alwaysMountedSet, ...retainedCandidateIds])]
    }
    return ids.filter((id) => isVisibleContent(id))
  }

  // -- DnD pane handlers
  const dropEdgeForEvent = (paneId: string, e: DragEvent) => {
    let el: HTMLElement | null = (e.currentTarget as HTMLElement) ?? (e.target as HTMLElement)
    while (el && el.dataset?.paneId !== paneId) el = el.parentElement
    const target = el ?? (e.currentTarget as HTMLElement) ?? (e.target as HTMLElement)
    const rect = target.getBoundingClientRect()
    const edge = computeDropEdge(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      e.clientX,
      e.clientY,
    )
    return edge
  }
  const onPaneDragOver = (paneId: string, e: DragEvent) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes(WORKBENCH_DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    setDropTarget({ paneId, edge: dropEdgeForEvent(paneId, e) })
  }
  const onPaneDrop = (paneId: string, e: DragEvent) => {
    if (!e.dataTransfer) return
    if (dragSuppressed()) {
      setDragSuppressed(false)
      clearDropTarget()
      return
    }
    const cid = e.dataTransfer.getData(WORKBENCH_DRAG_MIME)
    if (!cid) return
    const edge = dropEdgeForEvent(paneId, e)
    const s = ctx.getState()
    if (!s.contentIds.includes(cid)) return // reject external unknowns
    e.preventDefault()
    e.stopPropagation()
    clearDropTarget()
    wb.split.split(paneId, edge, cid)
  }

  const handleDragStart = (e: DragEvent, contentId: string) => {
    if (!e.dataTransfer) return
    e.dataTransfer.setData(WORKBENCH_DRAG_MIME, contentId)
    e.dataTransfer.effectAllowed = "move"
  }

  // -- Resize divider (top-level only for now; nested splits could use path "a"|"b")
  // Detect if root is a split; if so, render a divider.
  const rootSplit = createMemo(() => {
    const r = ctx.getState().split.root
    return r && r.t === "split" ? r : null
  })
  const dropTargetPaneStyle = (paneId: string): JSX.CSSProperties => {
    const style = paneRectStyle(paneId)
    if (style.display === "none") return style
    return {
      ...style,
      "z-index": "45",
      "pointer-events": "none",
    }
  }

  return (
    <div
      ref={(el) => (rootEl = el)}
      data-testid="workbench-root"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        "background-color": "var(--background-base)",
      }}
      tabindex="-1"
    >
      <Show
        when={ctx.getState().panes.length > 0}
        fallback={<div data-testid="empty" class="h-full w-full">{props.renderEmpty?.()}</div>}
      >
        {/* Pane chrome layers — rendered absolutely positioned */}
        <For each={ctx.getState().panes}>
          {(pane) => {
            const renderEmptyForPane = () => (
              <div data-testid="empty" class="h-full w-full">{props.renderEmpty?.()}</div>
            )
            return (
              <div
                data-testid={`pane-${pane.id}`}
                data-pane-id={pane.id}
                style={{
                  ...paneRectStyle(pane.id),
                  display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                  overflow: "hidden",
                  "box-sizing": "border-box",
                }}
                class="bg-background-base/10"
                onDragOver={(e) => onPaneDragOver(pane.id, e)}
                onDrop={(e) => onPaneDrop(pane.id, e)}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clearDropTarget()
                }}
                onMouseDown={() => wb.split.focus(pane.id)}
              >
                <Show when={!pane.contentId}>{renderEmptyForPane()}</Show>
              </div>
            )
          }}
        </For>

        {/* Top-level resize divider, if root is a split */}
        <Show when={rootSplit()}>
          {(rs) => {
            const onPointerDown = (e: PointerEvent) => {
              const startRect = rootEl?.getBoundingClientRect()
              if (!startRect) return
              const onMove = (ev: PointerEvent) => {
                if (rs().dir === "h") {
                  const ratio = (ev.clientX - startRect.left) / startRect.width
                  wb.split.resize([], Math.min(1, Math.max(0, ratio)))
                } else {
                  const ratio = (ev.clientY - startRect.top) / startRect.height
                  wb.split.resize([], Math.min(1, Math.max(0, ratio)))
                }
              }
              const onUp = () => {
                window.removeEventListener("pointermove", onMove)
                window.removeEventListener("pointerup", onUp)
              }
              window.addEventListener("pointermove", onMove)
              window.addEventListener("pointerup", onUp)
              e.preventDefault()
            }
            const dividerStyle = (): JSX.CSSProperties => {
              const root = rs()
              if (root.dir === "h") {
                return {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `calc(${root.size * 100}% - 2px)`,
                  width: "4px",
                  cursor: "col-resize",
                  "z-index": "10",
                  background:
                    "linear-gradient(to right, transparent 0, transparent 1.5px, var(--border-weaker-base) 1.5px, var(--border-weaker-base) 2.5px, transparent 2.5px)",
                }
              }
              return {
                position: "absolute",
                left: 0,
                right: 0,
                top: `calc(${root.size * 100}% - 2px)`,
                height: "4px",
                cursor: "row-resize",
                "z-index": "10",
                background:
                  "linear-gradient(to bottom, transparent 0, transparent 1.5px, var(--border-weaker-base) 1.5px, var(--border-weaker-base) 2.5px, transparent 2.5px)",
              }
            }
            return (
              <div
                data-testid="workbench-divider"
                style={dividerStyle()}
                onPointerDown={onPointerDown}
              />
            )
          }}
        </Show>

        {/* Content slots — absolutely positioned, mount retention. */}
        <For each={aliveForRender()}>
          {(contentId) => {
            const visible = createMemo(() => isVisibleContent(contentId))
            const paneId = createMemo(() => paneOfContent(contentId))
            const inactive = createMemo(() => {
              const pid = paneId()
              const focused = ctx.getState().focusedPaneId
              return !!focused && !!pid && focused !== pid
            })
            const slotStyle = (): JSX.CSSProperties => {
              const pid = paneId()
              if (!pid) {
                // Stashed content stays mounted but fully hidden and cheap.
	                return {
	                  position: "absolute",
	                  inset: "0",
	                  width: "100%",
	                  height: "100%",
	                  visibility: "hidden",
	                  "content-visibility": "hidden",
	                  contain: "strict",
	                  "pointer-events": "none",
	                  overflow: "hidden",
                }
              }
              const rect = rectMemo().get(pid)
              if (!rect) return { display: "none" }
              return {
                position: "absolute",
                left: `${rect.left * 100}%`,
                top: `${rect.top * 100}%`,
	                width: `${rect.width * 100}%`,
	                height: `${rect.height * 100}%`,
	                display: visible() ? "block" : "none",
	                overflow: "hidden",
	              }
            }
            const paneCtx: PaneCtx = {
              paneId: paneId() ?? "",
              isFocused: () => {
                const pid = paneId()
                return pid !== null && ctx.getState().focusedPaneId === pid
              },
              isVisible: () => visible(),
              requestClose: (opts) => {
                const pid = paneId()
                if (pid) wb.split.close(pid, opts ?? { destroyContent: false })
              },
              requestFocus: () => {
                const pid = paneId()
                if (pid) wb.split.focus(pid)
              },
            }
            return (
              <div
                data-workbench-content={contentId}
                data-pane-id={paneId() ?? undefined}
                ref={(el) => {
                  const onSlotDragOver = (event: DragEvent) => {
                    const pid = paneId()
                    if (pid) onPaneDragOver(pid, event)
                  }
                  const onSlotDrop = (event: DragEvent) => {
                    const pid = paneId()
                    if (pid) onPaneDrop(pid, event)
                  }
                  const onSlotDragLeave = (event: DragEvent) => {
                    if (!el.contains(event.relatedTarget as Node | null)) clearDropTarget()
                  }
                  el.addEventListener("dragover", onSlotDragOver, true)
                  el.addEventListener("drop", onSlotDrop, true)
                  el.addEventListener("dragleave", onSlotDragLeave, true)
                  onCleanup(() => {
                    el.removeEventListener("dragover", onSlotDragOver, true)
                    el.removeEventListener("drop", onSlotDrop, true)
                    el.removeEventListener("dragleave", onSlotDragLeave, true)
                  })
                }}
                style={slotStyle()}
                class="transition-[opacity,filter] duration-100"
                classList={{
                  "opacity-55 saturate-[0.7]": inactive(),
                  "opacity-100 saturate-100": !inactive(),
                }}
                onMouseDown={() => {
                  const pid = paneId()
                  if (pid) wb.split.focus(pid)
                }}
              >
                {props.renderContent(contentId, paneCtx)}
              </div>
            )
          }}
        </For>

        <For each={ctx.getState().panes}>
          {(pane) => (
            <>
              <Show when={pane.contentId}>
                {(cid) => (
                  <div
                    data-testid={`pane-handle-${pane.id}`}
                    draggable
                    onDragStart={(event) => handleDragStart(event, cid())}
                    style={{
                      ...paneRectStyle(pane.id),
                      display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                      "pointer-events": "none",
                      "z-index": "35",
                    }}
                  />
                )}
              </Show>
              <Show when={ctx.getState().panes.length > 1 && pane.contentId}>
                <div
                  data-testid={`pane-close-zone-${pane.id}`}
                  style={{
                    ...paneRectStyle(pane.id),
                    display: paneRectStyle(pane.id).display === "none" ? "none" : "block",
                    "pointer-events": "none",
                    "z-index": "42",
                  }}
                >
                  <button
                    type="button"
                    aria-label="Close Pane"
                    data-testid={`pane-close-${pane.id}`}
                    draggable={false}
                    class="absolute right-2 top-2 flex size-5 items-center justify-center rounded border border-border-weak-base/35 bg-background-base/55 p-0 text-icon-weak-base opacity-35 backdrop-blur-sm outline-none transition-[opacity,background-color,color,border-color] duration-100 hover:border-border-base/70 hover:bg-surface-base-hover/90 hover:text-icon-base hover:opacity-100 focus-visible:border-border-base/70 focus-visible:bg-surface-base-hover/90 focus-visible:text-icon-base focus-visible:opacity-100"
                    style={{ "pointer-events": "auto" }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      wb.split.close(pane.id, { destroyContent: false })
                    }}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </div>
              </Show>
            </>
          )}
        </For>

        <Show when={dropTarget()}>
          {(target) => (
            <div
              data-testid={`drop-target-${target().paneId}`}
              style={dropTargetPaneStyle(target().paneId)}
              class="workbench-drop-target"
            >
              <DropTargetOverlay edge={target().edge} />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

function DropTargetOverlay(props: { edge: Edge }) {
  const zoneClass = (edge: Edge) =>
    [
      "absolute border transition-[opacity,transform,background-color,border-color,box-shadow] duration-100 ease-out",
      props.edge === edge
        ? "opacity-100 scale-100 border-border-strong-base bg-surface-base-active/80 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
        : "opacity-25 scale-100 border-border-weak-base/45 bg-surface-base-hover/30",
    ].join(" ")

  return (
    <div class="relative h-full w-full bg-background-base/16 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-[1px]">
      <div class={zoneClass("top")} style={{ top: 0, left: 0, right: 0, height: "32%" }} />
      <div class={zoneClass("bottom")} style={{ bottom: 0, left: 0, right: 0, height: "32%" }} />
      <div class={zoneClass("left")} style={{ top: 0, bottom: 0, left: 0, width: "32%" }} />
      <div class={zoneClass("right")} style={{ top: 0, bottom: 0, right: 0, width: "32%" }} />
    </div>
  )
}

function moveFocusByDirection(
  direction: "left" | "right" | "up" | "down",
  state: WorkbenchState,
  wb: ReturnType<typeof useWorkbench>,
) {
  const rects = computePaneRects(state.split.root)
  const focusedId = state.focusedPaneId
  if (!focusedId) return
  const me = rects.get(focusedId)
  if (!me) return
  const cx = me.left + me.width / 2
  const cy = me.top + me.height / 2
  let best: { id: string; score: number } | null = null
  for (const [pid, r] of rects) {
    if (pid === focusedId) continue
    const rcx = r.left + r.width / 2
    const rcy = r.top + r.height / 2
    let valid = false
    let score = 0
    if (direction === "left") {
      valid = rcx < cx
      score = cx - rcx + Math.abs(rcy - cy) * 2
    } else if (direction === "right") {
      valid = rcx > cx
      score = rcx - cx + Math.abs(rcy - cy) * 2
    } else if (direction === "up") {
      valid = rcy < cy
      score = cy - rcy + Math.abs(rcx - cx) * 2
    } else {
      valid = rcy > cy
      score = rcy - cy + Math.abs(rcx - cx) * 2
    }
    if (!valid) continue
    if (!best || score < best.score) best = { id: pid, score }
  }
  if (best) wb.split.focus(best.id)
}
