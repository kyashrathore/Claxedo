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
        class="flex shrink-0 items-stretch gap-1 border-t border-border-muted bg-background-layer-01 px-1.5 py-1"
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
              class="flex h-11 min-w-11 flex-1 items-center justify-center rounded-md border border-border-muted font-mono text-base text-text-base active:bg-overlay-pressed"
              classList={{ "bg-overlay-pressed": key.id === "ctrl" && ctrlArmed() }}
            >
              {key.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
