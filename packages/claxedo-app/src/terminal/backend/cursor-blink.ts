import type { Terminal as XTerm } from "@xterm/xterm"
import type { Disposer } from "@/shell"

export function blinkWhileFocused(xterm: XTerm): Disposer | undefined {
  const textarea = xterm.textarea
  if (!textarea) return undefined
  const onFocus = () => (xterm.options.cursorBlink = true)
  const onBlur = () => (xterm.options.cursorBlink = false)
  textarea.addEventListener("focus", onFocus)
  textarea.addEventListener("blur", onBlur)
  return () => {
    textarea.removeEventListener("focus", onFocus)
    textarea.removeEventListener("blur", onBlur)
  }
}
