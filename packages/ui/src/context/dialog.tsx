import {
  createContext,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  For,
} from "solid-js"
import type { JSX } from "@solidjs/web"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    // Drives `data-closing` on the layer wrapper, which is what plays the exit
    // animation (see dialog.css). It deliberately does NOT flip Kobalte's
    // `open` — see the comment on `mount()`.
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
    }, 100)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || stack().length === 0) return
    close()
    event.preventDefault()
    event.stopPropagation()
  }
  if (typeof window !== "undefined") {
    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  }

  /**
   * A mounted dialog is torn down by disposing its root, never by flipping
   * Kobalte's `open` to false.
   *
   * `@solidjs/signals@2.0.0-rc.3` defers a pure computation's child disposal:
   * `recompute()` moves the node's children and cleanups onto a *pending* list
   * and commits them later, in `commitPendingNode`. `disposeChildren()` only
   * drains the live lists, so an owner disposed in the same flush in which a
   * descendant memo recomputed loses that memo's cleanups outright — the owner
   * is left ZOMBIE with its `onCleanup` handlers intact but never run.
   *
   * Flipping `open` walks straight into that: Kobalte's presence signal feeds
   * both `Dialog.Portal`'s `<Show>` (which disposes the portal subtree) and
   * `Dialog.Content`'s inner `<Show>` (which recomputes and stashes its pending
   * disposal), in one flush. The cleanup that gets dropped is
   * `DismissableLayer`'s, whose job is to `removeLayer()` and
   * `restoreBodyPointerEvents()`. The page is then left with
   * `body { pointer-events: none }` forever and swallows every subsequent
   * click.
   *
   * Keeping `open` constant makes teardown a single, undeferred disposal pass,
   * and the exit animation becomes ours (`data-closing`) instead of Kobalte's
   * `data-expanded`. `onOpenChange` still fires for Escape and outside-pointer
   * dismissal, because the `open` prop stays controlled by us.
   */
  const mount = (element: DialogElement, owner: Owner, onClose: (() => void) | undefined, layer: number) => {
    const id = Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    const mounted = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        const [closing, setClosingSignal] = createSignal(false)
        return {
          dispose: d,
          setClosing: setClosingSignal,
          node: (
            <Kobalte
              modal
              open
              onOpenChange={(open: boolean) => {
                if (open) return
                close(id)
              }}
            >
              <Kobalte.Portal>
                <Kobalte.Overlay
                  data-component="dialog-overlay"
                  class="ui-dialog-overlay"
                  style={{ "z-index": String(zIndex) }}
                  onClick={() => close(id)}
                />
                <div
                  data-dialog-layer={layer}
                  data-closing={closing() ? "" : undefined}
                  style={{
                    position: "fixed",
                    inset: "0",
                    "z-index": String(zIndex),
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "pointer-events": "none",
                  }}
                >
                  {element()}
                </div>
              </Kobalte.Portal>
            </Kobalte>
          ),
        }
      }),
    )

    if (!mounted) return

    const active: Active = { id, owner, onClose, ...mounted }
    setStack((items) => [...items, active])
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, stack().length)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    const items = stack()
    setStack([])
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    items.forEach((item) => item.dispose())
    mount(element, owner, onClose, 0)
  }

  return {
    stack,
    close,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.stack().at(-1)
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return ctx.show(element, base, onClose)
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return ctx.push(element, base, onClose)
    },
    close() {
      ctx.close()
    },
  }
}
