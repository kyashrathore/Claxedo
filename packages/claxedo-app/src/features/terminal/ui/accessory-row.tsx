import { For, Show, createSignal } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { BP_MD, COARSE_POINTER_QUERY, mediaQueryBelow } from "@/ui/controls/breakpoints"
import { type AccessoryKey, resolveAccessoryKey } from "./accessory-keys"

export interface TerminalAccessoryRowProps {
  /**
   * Feed a byte sequence into the terminal's input path. Wire this to the same
   * handler xterm's `onData` uses so accessory keys are indistinguishable from
   * typed input (interrupt detection, reply filtering, PTY socket send).
   */
  onKey: (data: string) => void
  /**
   * Extra visibility gate (e.g. "this terminal is focused"), so background
   * panes don't stack their own fixed key bars. Defaults to always-on.
   */
  active?: () => boolean
  /**
   * Test/override hook for the media condition. When omitted, the row shows
   * only on coarse-pointer (touch) OR sub-`md` (narrow) viewports — i.e. never
   * on a desktop mouse layout.
   */
  visible?: () => boolean
}

const KEYS: Array<{ id: AccessoryKey; label: string; aria: string }> = [
  { id: "esc", label: "Esc", aria: "Escape" },
  { id: "tab", label: "Tab", aria: "Tab" },
  { id: "ctrl", label: "Ctrl", aria: "Control" },
  { id: "left", label: "←", aria: "Left arrow" },
  { id: "down", label: "↓", aria: "Down arrow" },
  { id: "up", label: "↑", aria: "Up arrow" },
  { id: "right", label: "→", aria: "Right arrow" },
]

/**
 * Default visibility signal: coarse pointer OR narrow viewport, both derived
 * from the shared breakpoint tokens. Falls back to always-hidden when
 * `matchMedia` is unavailable (SSR / jsdom without a shim), which keeps the row
 * off desktop and out of the way in non-DOM test environments.
 */
function createCoarseOrNarrow(): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => false
  }
  const coarse = createMediaQuery(COARSE_POINTER_QUERY)
  const narrow = createMediaQuery(mediaQueryBelow(BP_MD))
  return () => coarse() || narrow()
}

/**
 * Mobile soft-keyboard accessory bar: Esc / Tab / Ctrl (sticky) / arrows. Fixed
 * to the bottom of the viewport so it rides above the on-screen keyboard, and
 * rendered only under coarse-pointer/narrow conditions (hidden on desktop).
 */
export function TerminalAccessoryRow(props: TerminalAccessoryRowProps) {
  const [ctrlArmed, setCtrlArmed] = createSignal(false)
  const mediaVisible = createCoarseOrNarrow()
  const visible = () => (props.visible?.() ?? mediaVisible()) && (props.active?.() ?? true)

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
        data-component="terminal-accessory-row"
        role="toolbar"
        aria-label="Terminal keys"
        class="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-1 border-t border-border-weak-base/60 bg-surface-base/95 px-1.5 py-1 backdrop-blur"
        style={{ "padding-bottom": "max(0.25rem, env(safe-area-inset-bottom))" }}
      >
        <For each={KEYS}>
          {(key) => (
            <button
              type="button"
              // Non-focus-stealing: the terminal's textarea must KEEP focus when a
              // key is tapped. The row is a fixed sibling of the terminal container,
              // and that container gates its own visibility on `focusin/focusout`
              // (see terminal.tsx `active={terminalFocused}`). If a tap moved focus
              // to this button, the container would fire `focusout`, `active()` would
              // flip false, and the row would unmount mid-tap — so the very first key
              // would never reach the PTY. Preventing the pointerdown default keeps
              // focus on the textarea (click still fires), and `tabIndex={-1}` keeps
              // the buttons out of the tab ring.
              tabIndex={-1}
              aria-label={key.aria}
              aria-pressed={key.id === "ctrl" ? ctrlArmed() : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
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
