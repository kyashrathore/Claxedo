import { Show, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js"

export type RowMenuProps = {
  /** Rendered inside the trigger button. */
  label: JSX.Element
  ariaLabel: string
  triggerClass: string
  triggerTestId?: string
  disabled?: boolean
  align?: "start" | "end"
  children: (close: () => void) => JSX.Element
}

/**
 * A button and the panel it opens, on the row it belongs to.
 *
 * The panel is absent from the DOM while closed rather than hidden: a control
 * inside a hidden panel still takes focus from a keyboard walking the row, and
 * a list of fifty rows would put fifty status selects in the tab order.
 *
 * The kit ships without the host's menu primitive, so Escape and the
 * outside-press are wired here; both are what close it, and the trigger keeps
 * focus so the row does not lose its place.
 */
export function RowMenu(props: RowMenuProps) {
  const [open, setOpen] = createSignal(false)
  const panelId = createUniqueId()
  let trigger: HTMLButtonElement | undefined

  const close = () => {
    setOpen(false)
    trigger?.focus()
  }

  const watch = (panel: HTMLElement) => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panel.contains(target) || trigger?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      close()
    }
    window.addEventListener("pointerdown", onPointerDown, true)
    panel.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      panel.removeEventListener("keydown", onKeyDown)
    })
  }

  return (
    <span class="tsk-menu">
      <button
        ref={trigger}
        type="button"
        class={props.triggerClass}
        data-testid={props.triggerTestId}
        aria-label={props.ariaLabel}
        aria-haspopup="true"
        aria-expanded={open()}
        aria-controls={open() ? panelId : undefined}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
      >
        {props.label}
      </button>
      <Show when={open()}>
        <div ref={watch} id={panelId} class="tsk-menu-panel" data-align={props.align ?? "end"} role="group" aria-label={props.ariaLabel}>
          {props.children(close)}
        </div>
      </Show>
    </span>
  )
}
