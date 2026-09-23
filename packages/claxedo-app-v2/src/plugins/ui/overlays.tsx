import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, type Component } from "solid-js"
import type { DialogProps, MenuProps } from "@claxedo/plugin-api"
import { Icon } from "./controls"

export const Menu: Component<MenuProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined
  const onDocumentPointerDown = (event: PointerEvent) => {
    if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false)
  }
  createEffect(() => {
    if (!open()) return
    document.addEventListener("pointerdown", onDocumentPointerDown)
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    })
  })
  return (
    <div ref={root} class="relative inline-flex" data-testid={props["data-testid"]}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label={props.label}
        class="inline-flex items-center"
        onClick={() => setOpen((current) => !current)}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div role="menu" aria-label={props.label} class="absolute right-0 top-full z-20 mt-1 min-w-40 rounded-md border p-1">
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                data-danger={item.danger ? "true" : undefined}
                disabled={item.disabled}
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                <Show when={item.icon}>{(icon) => <Icon name={icon()} size="small" />}</Show>
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export const Dialog: Component<DialogProps> = (props) => {
  const titleId = createUniqueId()
  const descriptionId = createUniqueId()
  let panel: HTMLDivElement | undefined
  createEffect(() => {
    if (!props.open) return
    panel?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={props.description ? descriptionId : undefined}
          tabIndex={-1}
          data-testid={props["data-testid"]}
          class="flex w-full max-w-lg flex-col gap-3 rounded-lg border p-4 outline-none"
        >
          <h2 id={titleId} class="text-base font-medium">
            {props.title}
          </h2>
          <Show when={props.description}>
            <p id={descriptionId} class="text-sm">
              {props.description}
            </p>
          </Show>
          {props.children}
          <Show when={props.footer}>
            <div class="flex justify-end gap-2">{props.footer}</div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
