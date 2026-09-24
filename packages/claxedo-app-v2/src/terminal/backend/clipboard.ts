import type { Terminal as XTerm } from "@xterm/xterm"

type PasteTerminal = Pick<XTerm, "textarea" | "paste">
type CopyTerminal = Pick<XTerm, "element" | "getSelection">

export type PasteOptions = {
  readonly onWrite: (data: string) => void
  readonly bracketedPaste: () => boolean
}

export function bracketed(text: string, enabled: boolean): string {
  return enabled ? `\x1b[200~${text}\x1b[201~` : text
}

export function setupPaste(xterm: PasteTerminal, options: PasteOptions): () => void {
  const textarea = xterm.textarea
  if (!textarea) return () => {}
  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain")
    if (!text) {
      options.onWrite("\x16")
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    options.onWrite(bracketed(text.replace(/\r?\n/g, "\r"), options.bracketedPaste()))
  }
  textarea.addEventListener("paste", handlePaste, { capture: true })
  return () => textarea.removeEventListener("paste", handlePaste, { capture: true })
}

export function setupCopy(xterm: CopyTerminal): () => void {
  const element = xterm.element
  if (!element) return () => {}
  const handleCopy = (event: ClipboardEvent) => {
    const selection = xterm.getSelection()
    if (!selection) return
    const trimmed = selection
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
    if (!event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData("text/plain", trimmed)
  }
  element.addEventListener("copy", handleCopy)
  return () => element.removeEventListener("copy", handleCopy)
}
