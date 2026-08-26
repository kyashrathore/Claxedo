import { createStore, flush, reconcile } from "solid-js"
import { render } from "@solidjs/testing-library"
import type { JSX } from "@solidjs/web"
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
  renderContent?: (id: string, ctx: PaneCtx) => JSX.Element
}

export function mountWorkbench(opts: MountOpts = {}) {
  const initial = opts.initial ?? validate(undefined).state
  const [state, setState] = createStore<WorkbenchState>(initial)

  const focusEvents: FocusEvent[] = []
  const resizeEvents: ResizeEvent[] = []
  const openEvents: OpenEvent[] = []
  const closeEvents: CloseEvent[] = []
  const changeEvents: WorkbenchState[] = []

  let api!: UseWorkbench
  const Capture = () => {
    api = useWorkbench()
    // as-any: capture-only test component intentionally renders no DOM.
    return null as unknown as JSX.Element
  }

  const stateSource = {
    get current() {
      return state
    },
  }
  const utils = render(() => (
    <WorkbenchProvider
      state={stateSource}
      onChange={(next) => {
        changeEvents.push(next)
        setState(reconcile(next))
      }}
    >
      <Capture />
      <Workbench
        renderContent={
          opts.renderContent ??
          ((id: string, ctx: PaneCtx) => (
            <div data-testid={`content-${id}`} data-visible={ctx.isVisible() ? "1" : "0"} data-pane-id={ctx.paneId}>
              content {id}
            </div>
          ))
        }
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

  // Solid 2 stages store writes until the scheduler flushes, and these tests
  // drive the workbench API directly rather than through `fireEvent`, so nothing
  // settles on their behalf. Every DOM query goes through a flush first, which
  // is the DOM a user would be looking at after the interaction.
  const settled = new Proxy(utils, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        flush()
        return (value as (...values: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as typeof utils

  const gestureApi = new Proxy({} as UseWorkbench, {
    get(_target, key: string | symbol) {
      const value = Reflect.get(api as object, key) as unknown
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(api, args)
          flush()
          return result
        }
      }
      if (value && typeof value === "object") {
        return new Proxy(value as object, {
          get(_group, name: string | symbol) {
            const member = Reflect.get(value as object, name) as unknown
            if (typeof member !== "function") return member
            return (...args: unknown[]) => {
              const result = (member as (...a: unknown[]) => unknown).apply(value, args)
              flush()
              return result
            }
          },
        })
      }
      return value
    },
  })

  return {
    utils: settled,
    state: () => {
      flush()
      return state
    },
    setState,
    // Every call through here stands for a separate user gesture — open a tab,
    // show it, close it — and each lands in its own task in the shell. Solid 2
    // coalesces a whole sequence that shares one task into a single flush, so
    // the workbench's own effects would never observe the intermediate states
    // (a content added and removed in one task fires neither `onContentOpen`
    // nor `onContentClose`). Flushing after each call keeps the tasks separate.
    api: () => gestureApi,
    focusEvents,
    resizeEvents,
    openEvents,
    closeEvents,
    changeEvents,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
