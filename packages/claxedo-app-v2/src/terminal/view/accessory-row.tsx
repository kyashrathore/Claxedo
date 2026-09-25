import { For, Show, createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useCoarsePointer, usePhone } from "@/lib/viewport"
import { dictionary, type TerminalKey } from "../i18n"
import { resolveAccessoryKey, type AccessoryKey } from "./accessory-keys"

const KEYS: readonly { readonly id: AccessoryKey; readonly label: string; readonly name: TerminalKey }[] = [
  { id: "esc", label: "Esc", name: "terminal.key.escape" },
  { id: "tab", label: "Tab", name: "terminal.key.tab" },
  { id: "ctrl", label: "Ctrl", name: "terminal.key.control" },
  { id: "left", label: "←", name: "terminal.key.left" },
  { id: "down", label: "↓", name: "terminal.key.down" },
  { id: "up", label: "↑", name: "terminal.key.up" },
  { id: "right", label: "→", name: "terminal.key.right" },
]

export function AccessoryRow(props: {
  readonly onKey: (data: string) => void
  readonly active: () => boolean
}): JSX.Element {
  const t = useTranslator(dictionary)
  const [ctrlArmed, setCtrlArmed] = createSignal(false)
  const coarse = useCoarsePointer()
  const phone = usePhone()
  const visible = () => (coarse() || phone()) && props.active()

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
        data-testid="terminal-keys"
        data-component="terminal-accessory-row"
        class="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-1 border-t border-border-weak-base/60 bg-surface-base/95 px-1.5 py-1 backdrop-blur"
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
              class="flex h-10 min-w-10 flex-1 items-center justify-center rounded-md border border-border-weak-base/50 bg-surface-base-hover/40 font-mono text-sm text-text-base active:bg-surface-base-hover"
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
