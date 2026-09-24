import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"
import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  ErrorBoundary,
  For,
  getOwner,
  onCleanup,
  onMount,
  runWithOwner,
  startTransition,
  Suspense,
  useContext,
  type JSX,
  type Owner,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"

type DialogElement = () => JSX.Element

type ActiveDialog = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  pending: () => boolean
}

const closeAnimationMs = 100

function ReadySentinel(props: { ready: () => void }) {
  onMount(props.ready)
  return null
}

function DialogFailure(props: { error: unknown; onClose: () => void }) {
  const message = () => {
    const error = props.error
    if (error instanceof Error && error.message) return error.message
    if (typeof error === "string" && error) return error
    return "Something went wrong."
  }
  return (
    <div data-component="dialog-error" role="alert" class="ui-dialog-error">
      <p data-slot="dialog-error-message">{message()}</p>
      <button type="button" data-slot="dialog-error-close" onClick={() => props.onClose()}>
        Close
      </button>
    </div>
  )
}

function DialogLayer(props: {
  layer: () => number
  closing: () => boolean
  close: () => void
  ready: () => void
  element: DialogElement
}) {
  const zIndex = () => String(50 + props.layer() * 10)
  return (
    <Kobalte modal open={!props.closing()} onOpenChange={(open) => !open && props.close()}>
      <Kobalte.Portal>
        <Kobalte.Overlay class="ui-dialog-overlay" style={{ "z-index": zIndex() }} onClick={() => props.close()} />
        <div data-dialog-layer={props.layer()} class="ui-dialog-layer" style={{ "z-index": zIndex() }}>
          <ErrorBoundary fallback={(error: unknown) => <DialogFailure error={error} onClose={() => props.close()} />}>
            <Suspense fallback={null}>
              {props.element()}
              <ReadySentinel ready={props.ready} />
            </Suspense>
          </ErrorBoundary>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}

function createDialogStack() {
  const [state, setState] = createStore({ stack: [] as ActiveDialog[] })
  const retired = new Set<ActiveDialog>()
  const closing = { timer: undefined as ReturnType<typeof setTimeout> | undefined, locked: false }

  const cancelTimer = () => {
    if (closing.timer !== undefined) clearTimeout(closing.timer)
    closing.timer = undefined
    closing.locked = false
  }
  onCleanup(cancelTimer)

  createEffect(() => {
    if (state.stack.some((item) => item.pending()) || retired.size === 0) return
    for (const item of retired) item.dispose()
    retired.clear()
  })

  const close = (id?: string) => {
    const current = id ? state.stack.find((item) => item.id === id) : state.stack.at(-1)
    if (!current || closing.locked) return
    closing.locked = true
    current.onClose?.()
    current.setClosing(true)
    if (closing.timer !== undefined) clearTimeout(closing.timer)
    closing.timer = setTimeout(() => {
      closing.timer = undefined
      current.dispose()
      setState("stack", (items) => items.filter((item) => item.id !== current.id))
      closing.locked = false
    }, closeAnimationMs)
  }

  createEffect(() => {
    if (state.stack.length === 0) return
    makeEventListener(
      window,
      "keydown",
      (event) => {
        if (event.key !== "Escape") return
        if (event.target instanceof Element && event.target.closest("[data-owns-escape]")) return
        close()
        event.preventDefault()
        event.stopPropagation()
      },
      { capture: true },
    )
  })

  const mount = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    const id = Math.random().toString(36).slice(2)
    const layer = () => Math.max(0, state.stack.findIndex((item) => item.id === id))
    runWithOwner(owner, () =>
      createRoot((dispose) => {
        const [isClosing, setClosing] = createSignal(false)
        const [pending, setPending] = createSignal(true)
        const node = (
          <DialogLayer layer={layer} closing={isClosing} close={() => close(id)} ready={() => setPending(false)} element={element} />
        )
        setState("stack", produce((items) => items.push({ id, node, dispose, owner, onClose, setClosing, pending })))
      }),
    )
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    cancelTimer()
    mount(element, owner, onClose)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    cancelTimer()
    const replaced = state.stack
    for (const item of replaced) retired.add(item)
    mount(element, owner, onClose)
    setState("stack", (items) => items.filter((item) => !replaced.includes(item)))
  }

  return { stack: () => state.stack, close, show, push }
}

const DialogContext = createContext<ReturnType<typeof createDialogStack>>()

export function DialogProvider(props: ParentProps) {
  const stack = createDialogStack()
  return (
    <DialogContext.Provider value={stack}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={stack.stack()}>{(item) => item.node}</For>
      </div>
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const stack = useContext(DialogContext)
  const owner = getOwner()
  if (!stack || !owner) throw new Error("useDialog needs a DialogProvider above it")
  const base = () => stack.stack().at(-1)?.owner ?? owner
  return {
    get active() {
      return stack.stack().at(-1)
    },
    show: (element: DialogElement, onClose?: () => void) => startTransition(() => stack.show(element, base(), onClose)),
    push: (element: DialogElement, onClose?: () => void) => startTransition(() => stack.push(element, base(), onClose)),
    close: () => stack.close(),
  }
}
