import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  onMount,
  startTransition,
  For,
  Suspense,
  ErrorBoundary,
} from "solid-js"
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
  pending: () => boolean
}

/**
 * Mounts with the dialog's content, so it is the moment the stack can hand the
 * screen over. A dialog whose component is loaded lazily suspends the boundary
 * above until its chunk lands, and nothing it renders reaches the DOM before.
 */
function ReadySentinel(props: { ready: () => void }) {
  onMount(props.ready)
  return null
}

/** What a dialog shows in place of content it could not render. */
function DialogFailure(props: { error: unknown; onClose: () => void }) {
  const message = () => {
    const error = props.error
    if (error instanceof Error && error.message) return error.message
    if (typeof error === "string" && error) return error
    return "Something went wrong."
  }
  return (
    <div data-component="dialog-error" role="alert" class="ui-dialog-error" style={{ "pointer-events": "auto" }}>
      <p data-slot="dialog-error-message">{message()}</p>
      <button type="button" data-slot="dialog-error-close" data-testid="dialog-error-close" onClick={() => props.onClose()}>
        Close
      </button>
    </div>
  )
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }
  const retired = new Set<Active>()

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  // A dialog replaced by `show()` keeps its root — and so its portal, and so
  // the screen — until the replacement has content to put there. A dialog that
  // loads its component lazily renders nothing for as long as its chunk takes,
  // so disposing on the call instead leaves the app with no dialog at all for
  // that whole span.
  createEffect(() => {
    const loading = stack().some((item) => item.pending())
    if (loading || retired.size === 0) return
    for (const item of retired) item.dispose()
    retired.clear()
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
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

  createEffect(() => {
    if (stack().length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (element: DialogElement, owner: Owner, onClose: (() => void) | undefined) => {
    const id = Math.random().toString(36).slice(2)
    const layer = () => Math.max(0, stack().findIndex((item) => item.id === id))
    const zIndex = () => 50 + layer() * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined
    let pending: (() => boolean) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        const [isPending, setPending] = createSignal(true)
        pending = isPending
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay
                data-component="dialog-overlay"
                class="ui-dialog-overlay"
                style={{ "z-index": String(zIndex()) }}
                onClick={() => close(id)}
              />
              <div
                data-dialog-layer={layer()}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": String(zIndex()),
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                {/* A dialog is mounted from the caller's owner, so a throw
                    inside one lands on whatever boundary encloses that caller —
                    which is the application's own. One Settings pane whose
                    consent endpoint answered 404 replaced the entire app with
                    the error page, taking the shell, the toast region and the
                    workbench header with it. A dialog's failure ends at the
                    dialog. */}
                <ErrorBoundary fallback={(error: unknown) => (
                  <DialogFailure error={error} onClose={() => close(id)} />
                )}>
                  <Suspense fallback={null}>
                    {element()}
                    <ReadySentinel ready={() => setPending(false)} />
                  </Suspense>
                </ErrorBoundary>
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing || !pending) return

    const active: Active = { id, node, dispose, owner, onClose, setClosing, pending }
    setStack((items) => [...items, active])
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    const replaced = stack()
    for (const item of replaced) retired.add(item)
    mount(element, owner, onClose)
    setStack((items) => items.filter((item) => !replaced.includes(item)))
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
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
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
      return startTransition(() => ctx.show(element, base, onClose))
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.push(element, base, onClose))
    },
    close() {
      ctx.close()
    },
  }
}
