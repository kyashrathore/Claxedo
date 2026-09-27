import type { Terminal as XTerm } from "@xterm/xterm"
import { copyText } from "@/lib/clipboard"

type PasteTerminal = Pick<XTerm, "textarea" | "paste">
type CopyTerminal = Pick<XTerm, "element" | "getSelection">

export type PasteOptions = {
  readonly onWrite: (data: string) => void
  readonly bracketedPaste: () => boolean
}

export function bracketed(text: string, enabled: boolean): string {
  return enabled ? `\x1b[200~${text}\x1b[201~` : text
}

const MAX_SYNC_PASTE_CHARS = 16_384
const CHUNK_CHARS = 4096
const CHUNK_DELAY_MS = 5

function writeChunked(text: string, write: (chunk: string) => void): () => void {
  let cancelled = false
  let offset = 0
  const next = () => {
    if (cancelled) return
    write(text.slice(offset, offset + CHUNK_CHARS))
    offset += CHUNK_CHARS
    if (offset < text.length) setTimeout(next, CHUNK_DELAY_MS)
  }
  next()
  return () => {
    cancelled = true
  }
}

export function setupPaste(xterm: PasteTerminal, options: PasteOptions): () => void {
  const textarea = xterm.textarea
  if (!textarea) return () => {}
  let cancelActive: (() => void) | undefined
  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain")
    if (!text) {
      options.onWrite("\x16")
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelActive?.()
    cancelActive = undefined
    const prepared = text.replace(/\r?\n/g, "\r")
    const wrap = options.bracketedPaste()
    const write = (chunk: string) => options.onWrite(bracketed(chunk, wrap))
    if (prepared.length <= MAX_SYNC_PASTE_CHARS) write(prepared)
    else cancelActive = writeChunked(prepared, write)
  }
  textarea.addEventListener("paste", handlePaste, { capture: true })
  return () => {
    cancelActive?.()
    textarea.removeEventListener("paste", handlePaste, { capture: true })
  }
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
    if (!event.clipboardData) {
      void copyText(trimmed)
      return
    }
    event.preventDefault()
    event.clipboardData.setData("text/plain", trimmed)
  }
  element.addEventListener("copy", handleCopy)
  return () => element.removeEventListener("copy", handleCopy)
}
