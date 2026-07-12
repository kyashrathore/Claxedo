/**
 * Side dock for the page editor: resizable session/arena panel docked to
 * the left or right of the page, with the arena wave tab strip.
 *
 * Pure presentation over signals/handlers owned by PageEditorLoaded —
 * received as props (PageArenaDock keeps its own internals). Extracted
 * verbatim from page-editor.tsx (Plan 005); markup, classes, and behavior
 * unchanged.
 */

import { Show, For, createEffect, createMemo, onCleanup } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { PageArenaDock } from "./page-arena-dock"
import { arenaApi, type ArenaState, type ArenaWaveState } from "@/features/documents/data/arena-api"
import {
  clampDockWidth as clampDockWidthFor,
  visibleArenaWavesOf,
  resolveActiveArenaWave,
  arenaTabLabel as arenaTabLabelOf,
} from "./page-editor-model"

export type PageEditorDockStateDeps = {
  dockEnabled: () => boolean
  pageId: () => string
  dockPosition: () => "left" | "right"
  setDockPosition: (side: "left" | "right") => void
  dockWidth: () => number
  setDockWidth: (v: number | ((prev: number) => number)) => void
  dockMode: () => "session" | "arena"
  setDockMode: (mode: "session" | "arena") => void
  arenaWaves: () => ArenaWaveState[]
  setArenaWaves: (waves: ArenaWaveState[]) => void
  arenaTabs: () => string[]
  setArenaTabs: (v: string[] | ((prev: string[]) => string[])) => void
  arenaWave: () => string
  setArenaWave: (id: string) => void
}

/**
 * Dock/arena state flow: resize handling, dock persistence (localStorage),
 * arena wave refresh/open/close, and the polling + window-event effects.
 * Must be called inside the component body (effects register under the
 * caller's owner, in the same position the inline code occupied). Signals
 * stay owned by PageEditorLoaded and are passed in as getter/setter
 * functions. Extracted verbatim from page-editor.tsx (Plan 005).
 */
export function createPageEditorDockState(deps: PageEditorDockStateDeps) {
  const {
    dockEnabled,
    pageId,
    dockPosition,
    setDockPosition,
    dockWidth,
    setDockWidth,
    dockMode,
    setDockMode,
    arenaWaves,
    setArenaWaves,
    arenaTabs,
    setArenaTabs,
    arenaWave,
    setArenaWave,
  } = deps

  const clampDockWidth = (value: number) =>
    clampDockWidthFor(value, typeof window === "undefined" ? undefined : window.innerWidth)

  const startDockResize = (event: PointerEvent) => {
    if (!dockEnabled()) return
    const side = dockPosition()
    event.preventDefault()
    const move = (next: PointerEvent) => {
      const raw = side === "left" ? next.clientX - 8 : window.innerWidth - next.clientX - 8
      setDockWidth(clampDockWidth(raw))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    move(event)
  }

  const visibleArenaWaves = createMemo(() => visibleArenaWavesOf(arenaTabs(), arenaWaves()))

  const activeArenaWave = createMemo(() => resolveActiveArenaWave(arenaWave(), visibleArenaWaves()))

  const arenaTabLabel = (id: string) => arenaTabLabelOf(arenaWaves(), id)

  createEffect(() => {
    if (dockMode() !== "arena") return
    if (visibleArenaWaves().length > 0) return
    setDockMode("session")
  })

  const applyArenaState = (next: ArenaState) => {
    setArenaWaves(next.waves)
    setArenaTabs((current) => current.filter((id) => next.waves.some((wave) => wave.id === id)))
    const picked = arenaWave()
    if (picked && !next.waves.some((wave) => wave.id === picked)) setArenaWave("")
  }

  const arenaStateQuery = useQuery(() => ({
    queryKey: ["pages", "arenaState", pageId()],
    queryFn: () => arenaApi.state(pageId()),
    enabled: dockEnabled(),
    refetchInterval: dockEnabled() ? 4000 : false,
  }))

  createEffect(() => {
    const next = arenaStateQuery.data
    if (!next) return
    applyArenaState(next)
  })

  const refreshArenaWaves = async () => {
    if (!dockEnabled()) return
    const result = await arenaStateQuery.refetch()
    if (result.data) applyArenaState(result.data)
  }

  const openArenaWave = async (waveID?: string) => {
    await refreshArenaWaves()
    const target =
      (typeof waveID === "string" ? waveID.trim() : "") ||
      arenaWaves().find((wave) => wave.status === "running")?.id ||
      arenaWaves()[0]?.id ||
      ""
    if (!target) return
    setArenaTabs((current) => (current.includes(target) ? current : [target, ...current]))
    setArenaWave(target)
    setDockMode("arena")
  }

  const closeArenaWave = (waveID: string) => {
    setArenaTabs((current) => current.filter((id) => id !== waveID))
    if (arenaWave() !== waveID) return
    const next = visibleArenaWaves().find((wave) => wave.id !== waveID)?.id || ""
    if (!next) {
      setArenaWave("")
      setDockMode("session")
      return
    }
    setArenaWave(next)
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    const onArenaWave = (event: Event) => {
      const detail = (event as CustomEvent<{ pageId?: string; waveId?: string }>).detail
      const target = typeof detail?.pageId === "string" ? detail.pageId.trim() : ""
      if (target && target !== pageId()) return
      void refreshArenaWaves()
    }
    window.addEventListener("claxedo-page-arena-wave", onArenaWave as EventListener)
    onCleanup(() => window.removeEventListener("claxedo-page-arena-wave", onArenaWave as EventListener))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    const saved = window.localStorage.getItem("claxedo.page.dock.position")
    if (saved === "left" || saved === "right") setDockPosition(saved)
    if (saved === "center") setDockPosition("right")
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    const saved = Number(window.localStorage.getItem("claxedo.page.dock.width"))
    if (Number.isFinite(saved) && saved > 0) setDockWidth(clampDockWidth(saved))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.getItem !== "function") return
    setDockMode("session")
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.setItem !== "function") return
    window.localStorage.setItem("claxedo.page.dock.position", dockPosition())
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!window.localStorage || typeof window.localStorage.setItem !== "function") return
    window.localStorage.setItem("claxedo.page.dock.width", String(dockWidth()))
  })
  createEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => setDockWidth((current) => clampDockWidth(current))
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  return {
    startDockResize,
    visibleArenaWaves,
    activeArenaWave,
    arenaTabLabel,
    refreshArenaWaves,
    openArenaWave,
    closeArenaWave,
  }
}

export type PageEditorDockProps = {
  pageId: () => string
  directory: () => string | undefined
  dockEnabled: () => boolean
  dockPosition: () => "left" | "right"
  setDockPosition: (side: "left" | "right") => void
  dockWidth: () => number
  dockExpanded: () => boolean
  setDockExpanded: (v: boolean) => void
  dockMode: () => "session" | "arena"
  setDockMode: (mode: "session" | "arena") => void
  dockSessionId: () => string | undefined
  visibleArenaWaves: () => ArenaWaveState[]
  activeArenaWave: () => string
  arenaTabLabel: (id: string) => string
  setArenaWave: (id: string) => void
  closeArenaWave: (id: string) => void
  setArenaWaves: (waves: ArenaWaveState[]) => void
  startDockResize: (event: PointerEvent) => void
}

export function PageEditorDock(props: PageEditorDockProps) {
  return (
    <Show when={props.dockEnabled()}>
      <div
        classList={{
          "absolute z-20 pointer-events-auto notion-page-dock-side notion-page-dock-side-left":
            props.dockPosition() === "left",
          "absolute z-20 pointer-events-auto notion-page-dock-side notion-page-dock-side-right":
            props.dockPosition() === "right",
        }}
        style={{ "--page-side-dock-width": `${props.dockWidth()}px` }}
      >
        <button
          type="button"
          classList={{
            "notion-page-dock-resize": true,
            "notion-page-dock-resize-left": props.dockPosition() === "left",
            "notion-page-dock-resize-right": props.dockPosition() === "right",
          }}
          onPointerDown={(event) => props.startDockResize(event)}
          aria-label="Resize side dock"
        />
        <div class="notion-page-dock-mobile-header">
          <div class="text-12-regular text-text-weak truncate">Session</div>
          <IconButton
            variant="ghost"
            size="small"
            icon={props.dockExpanded() ? "collapse" : "expand"}
            onClick={() => props.setDockExpanded(!props.dockExpanded())}
          />
        </div>
        <div
          class="notion-page-dock-frame notion-page-dock-frame-side"
          classList={{ "notion-page-dock-frame-expanded": props.dockExpanded() }}
        >
          <div class="notion-page-dock-toolbar notion-page-dock-toolbar-side">
            <div class="notion-page-dock-tabstrip">
              <button
                type="button"
                class="notion-dock-mode-btn"
                classList={{ "notion-dock-mode-btn-active": props.dockMode() === "session" }}
                onClick={() => props.setDockMode("session")}
              >
                Session
              </button>
              <For each={props.visibleArenaWaves()}>
                {(wave) => (
                  <button
                    type="button"
                    class="notion-dock-mode-btn notion-arena-tab"
                    classList={{
                      "notion-dock-mode-btn-active": props.dockMode() === "arena" && props.activeArenaWave() === wave.id,
                    }}
                    onClick={() => {
                      props.setDockMode("arena")
                      props.setArenaWave(wave.id)
                    }}
                  >
                    {props.arenaTabLabel(wave.id)}
                    <span
                      classList={{
                        "notion-arena-tab-dot": true,
                        "notion-arena-tab-dot-live": wave.status === "running",
                      }}
                    />
                    <span
                      class="notion-arena-tab-close"
                      role="button"
                      tabIndex={0}
                      aria-label="Close arena tab"
                      onClick={(event) => {
                        event.stopPropagation()
                        props.closeArenaWave(wave.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return
                        event.preventDefault()
                        event.stopPropagation()
                        props.closeArenaWave(wave.id)
                      }}
                    >
                      x
                    </span>
                  </button>
                )}
              </For>
            </div>
            <div class="flex items-center gap-0.5">
              <div classList={{ "border-b-2 border-text-base": props.dockPosition() === "left" }}>
                <IconButton
                  variant="ghost"
                  size="small"
                  icon="layout-left-partial"
                  onClick={() => props.setDockPosition("left")}
                  aria-label="Dock left"
                />
              </div>
              <div classList={{ "border-b-2 border-text-base": props.dockPosition() === "right" }}>
                <IconButton
                  variant="ghost"
                  size="small"
                  icon="layout-right-partial"
                  onClick={() => props.setDockPosition("right")}
                  aria-label="Dock right"
                />
              </div>
            </div>
          </div>
          <div class="notion-page-dock-body notion-page-dock-body-side">
            <Show
              when={props.dockMode() === "arena"}
              fallback={
                <div class="notion-page-dock-session px-3 py-3 text-xs text-text-weak">
                  Chat moved to pane #chat. Mention #doc there to include this page context.
                </div>
              }
            >
              <PageArenaDock
                pageId={props.pageId()}
                directory={props.directory()}
                parentSessionId={props.dockSessionId()}
                mode="side"
                activeWaveId={props.activeArenaWave()}
                onActiveWaveChange={props.setArenaWave}
                onWavesChange={props.setArenaWaves}
              />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
