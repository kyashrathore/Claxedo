import { createStore, reconcile } from "solid-js/store"
import { render } from "@solidjs/testing-library"
import { type JSX } from "solid-js"
import { WorkbenchProvider, useWorkbench, type UseWorkbench, Workbench, type PaneCtx } from "../index"
import type { WorkbenchState, KeyMap } from "../index"
import { validate } from "../index"

export type FocusEvent = { paneId: string | null; contentId: string | null }
export type ResizeEvent = {
  paneId: string
  rect: { top: number; left: number; width: number; height: number }
}
export type OpenEvent = { contentId: string; paneId: string }
export type CloseEvent = { contentId: string; reason: string }

export type MountOpts = {
  initial?: WorkbenchState
  mountPolicy?: "always" | "active-only" | "visible-once"
  maxMountedContents?: number
  mountCapCandidate?: (contentId: string) => boolean
  retainedHiddenLimit?: () => number
  keyMap?: Partial<KeyMap>
}

export function mountWorkbench(opts: MountOpts = {}) {
  const initial = opts.initial ?? validate(undefined).state
  const [state, setState] = createStore<WorkbenchState>(initial)

  const focusEvents: FocusEvent[] = []
  const resizeEvents: ResizeEvent[] = []
  const openEvents: OpenEvent[] = []
  const closeEvents: CloseEvent[] = []

  let api!: UseWorkbench
  const Capture = () => {
    api = useWorkbench()
    // as-any: capture-only test component intentionally renders no DOM.
    return null as unknown as JSX.Element
  }

  const utils = render(() => (
    <WorkbenchProvider state={state} onChange={(next) => setState(reconcile(next))}>
      <Capture />
      <Workbench
        renderContent={(id: string, ctx: PaneCtx) => (
          <div data-testid={`content-${id}`} data-visible={ctx.isVisible() ? "1" : "0"}>
            content {id}
          </div>
        )}
        renderEmpty={() => <div data-testid="empty">empty</div>}
        mountPolicy={opts.mountPolicy}
        maxMountedContents={opts.maxMountedContents}
        mountCapCandidate={opts.mountCapCandidate}
        retainedHiddenLimit={opts.retainedHiddenLimit}
        keyMap={opts.keyMap}
        onFocusChange={(p, c) => focusEvents.push({ paneId: p, contentId: c })}
        onPaneResize={(p, r) => resizeEvents.push({ paneId: p, rect: r })}
        onContentOpen={(c, p) => openEvents.push({ contentId: c, paneId: p })}
        onContentClose={(c, r) => closeEvents.push({ contentId: c, reason: r })}
      />
    </WorkbenchProvider>
  ))

  return {
    utils,
    state: () => state,
    setState,
    api: () => api,
    focusEvents,
    resizeEvents,
    openEvents,
    closeEvents,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
