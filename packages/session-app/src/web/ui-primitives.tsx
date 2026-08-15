/**
 * Composer primitives: chip triggers and an anchored dropdown, Solid 2.
 *
 * The current app's composer chips are Kobalte dropdown menus; these mirror
 * the same interaction contract (trigger button with aria-haspopup, anchored
 * float below/above, Escape/blur dismissal, keyboard navigation) without a
 * component library — the session-app carries no Solid 1 dependencies.
 */

import { For, Show, createSignal, createEffect, onCleanup, type JSX } from "solid-js"

export type DropdownItem = {
  id: string
  label: string
  detail?: string
  disabled?: boolean
  selected?: boolean
}

export function ChipDropdown(props: {
  action: string
  label: string
  icon?: JSX.Element
  disabled?: boolean
  items: DropdownItem[]
  onSelect: (id: string) => void
  /** Optional footer row, e.g. "+ New worktree". */
  footer?: { label: string; onSelect: () => void }
}) {
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  let root: HTMLDivElement | undefined

  const close = () => setOpen(false)
  const toggle = () => {
    if (props.disabled) return
    setOpen(!open())
    setActive(Math.max(0, props.items.findIndex((item) => item.selected)))
  }
  const choose = (id: string) => {
    props.onSelect(id)
    close()
  }

  createEffect(() => {
    if (!open()) return
    const onDocPointer = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActive((index) => Math.min(index + 1, props.items.length - 1))
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
      }
      if (event.key === "Enter") {
        const item = props.items[active()]
        if (item && !item.disabled) choose(item.id)
      }
    }
    document.addEventListener("pointerdown", onDocPointer)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocPointer)
      document.removeEventListener("keydown", onKey)
    })
  })

  return (
    <div class="chip-root" ref={root}>
      <button
        type="button"
        class="chip"
        data-action={props.action}
        aria-haspopup="true"
        aria-expanded={open()}
        disabled={props.disabled}
        onClick={toggle}
      >
        <Show when={props.icon}>{props.icon}</Show>
        <span class="chip-label">{props.label}</span>
        <span class="chip-caret" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="chip-menu" role="menu">
          <For each={props.items}>{(item, index) => (
            <button
              type="button"
              role="menuitem"
              class="chip-menu-item"
              data-active={index() === active() ? "" : undefined}
              data-selected={item.selected ? "" : undefined}
              disabled={item.disabled}
              onMouseEnter={() => setActive(index())}
              onClick={() => choose(item.id)}
            >
              <span class="chip-menu-check" aria-hidden="true">{item.selected ? "✓" : ""}</span>
              <span class="chip-menu-label">{item.label}</span>
              <Show when={item.detail}>
                <span class="chip-menu-detail">{item.detail}</span>
              </Show>
            </button>
          )}</For>
          <Show when={props.footer}>
            <div class="chip-menu-separator" />
            <button
              type="button"
              role="menuitem"
              class="chip-menu-item chip-menu-footer"
              onClick={() => {
                props.footer?.onSelect()
                close()
              }}
            >
              {props.footer?.label}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/** Inline text-entry dialog row (worktree name, API key) — minimal, keyboard-first. */
export function InlinePrompt(props: {
  label: string
  placeholder?: string
  secret?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  let input: HTMLInputElement | undefined
  createEffect(() => input?.focus())
  return (
    <div class="inline-prompt">
      <span class="inline-prompt-label">{props.label}</span>
      <input
        ref={input}
        class="inline-prompt-input"
        type={props.secret ? "password" : "text"}
        placeholder={props.placeholder ?? ""}
        onKeyDown={(event) => {
          if (event.key === "Enter") props.onSubmit(event.currentTarget.value)
          if (event.key === "Escape") props.onCancel()
        }}
      />
      <button type="button" class="inline-prompt-cancel" onClick={() => props.onCancel()}>Cancel</button>
    </div>
  )
}
