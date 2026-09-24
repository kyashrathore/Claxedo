import { For, Show, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { NARROW_VIEWPORT_PX } from "../backend/options"
import { resolveAccessoryKey, type AccessoryKey } from "./accessory-keys"
import { t, type TerminalStringKey } from "../i18n"

const KEYS: readonly { id: AccessoryKey; label: string; name: TerminalStringKey }[] = [
  { id: "esc", label: "Esc", name: "terminal.key.escape" },
  { id: "tab", label: "Tab", name: "terminal.key.tab" },
  { id: "ctrl", label: "Ctrl", name: "terminal.key.control" },
  { id: "left", label: "←", name: "terminal.key.left" },
  { id: "down", label: "↓", name: "terminal.key.down" },
  { id: "up", label: "↑", name: "terminal.key.up" },
  { id: "right", label: "→", name: "terminal.key.right" },
]

export function AccessoryRow(props: { onKey: (data: string) => void; active: () => boolean }) {
  const [ctrlArmed, setCtrlArmed] = createSignal(false)
  const coarse = createMediaQuery("(pointer: coarse)")
  const narrow = createMediaQuery(`(max-width: ${NARROW_VIEWPORT_PX - 1}px)`)
  const visible = () => (coarse() || narrow()) && props.active()

  const press = (key: AccessoryKey) => {
    const action = resolveAccessoryKey(key, ctrlArmed())
    if (action.kind === "arm") {
      setCtrlArmed(action.ctrlArmed)
      return
    }
    props.onKey(action.data)
    if (ctrlArmed()) setCtrlArmed(false)
  }

  return (
    <Show when={visible()}>
      <div
        role="toolbar"
        aria-label={t("terminal.keys")}
        data-component="terminal-accessory-row"
        class="flex shrink-0 items-stretch gap-1 border-t border-border-weak-base bg-surface-base px-1.5 py-1"
        style={{ "padding-bottom": "max(0.25rem, env(safe-area-inset-bottom))" }}
      >
        <For each={KEYS}>
          {(key) => (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t(key.name)}
              aria-pressed={key.id === "ctrl" ? ctrlArmed() : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => press(key.id)}
              class="flex h-11 min-w-11 flex-1 items-center justify-center rounded-md border border-border-weak-base font-mono text-sm text-text-base active:bg-surface-base-hover"
              classList={{ "bg-surface-base-active text-text-strong": key.id === "ctrl" && ctrlArmed() }}
            >
              {key.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
