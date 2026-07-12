import type { Terminal as XTerm } from "@xterm/xterm"
import { objectProperty } from "./reflect"

type PasteHandlerTerminal = Pick<XTerm, "textarea" | "paste">
type CopyHandlerTerminal = Pick<XTerm, "element" | "getSelection">

function terminalApi(): unknown {
  if (typeof window === "undefined") return undefined
  return objectProperty(window, "api")
}

// ============================================================================
// Paste Handler with Bracketed Paste
// ============================================================================

export function setupPasteHandler(
  xterm: PasteHandlerTerminal,
  options: {
    onWrite?: (data: string) => void
    isBracketedPasteEnabled?: () => boolean
  } = {},
): () => void {
  const textarea = xterm.textarea
  if (!textarea) return () => {}

  // Track active paste to allow cancellation
  let cancelActivePaste: (() => void) | null = null

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain")
    if (!text) {
      // Non-text clipboard content (e.g. image): forward Ctrl+V so the
      // application can decide what to do with it (iTerm2/Ghostty behaviour).
      if (options.onWrite) options.onWrite("\x16")
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()

    // Cancel any in-flight chunked paste
    cancelActivePaste?.()
    cancelActivePaste = null

    // Constants for chunking
    const MAX_SYNC_PASTE_CHARS = 16_384
    const CHUNK_CHARS = 4096
    const CHUNK_DELAY_MS = 5

    if (!options.onWrite) {
      // Fallback to xterm's built-in paste (handles bracketed paste internally)
      if (text.length <= MAX_SYNC_PASTE_CHARS) {
        xterm.paste(text)
        return
      }

      // Chunk large pastes through xterm.paste()
      let cancelled = false
      let offset = 0

      const pasteNext = () => {
        if (cancelled) return
        const chunk = text.slice(offset, offset + CHUNK_CHARS)
        offset += CHUNK_CHARS
        xterm.paste(chunk)
        if (offset < text.length) {
          setTimeout(pasteNext, CHUNK_DELAY_MS)
        }
      }

      cancelActivePaste = () => {
        cancelled = true
      }
      pasteNext()
      return
    }

    // Normalize newlines for direct write
    const prepared = text.replace(/\r?\n/g, "\r")
    const bracketed = options.isBracketedPasteEnabled?.() ?? false

    // For small/medium pastes, use fast path
    if (prepared.length <= MAX_SYNC_PASTE_CHARS) {
      if (bracketed) {
        options.onWrite(`\x1b[200~${prepared}\x1b[201~`)
      } else {
        options.onWrite(prepared)
      }
      return
    }

    // Chunk large pastes to prevent PTY pipeline overflow
    let cancelled = false
    let offset = 0

    const pasteNext = () => {
      if (cancelled) return
      const chunk = prepared.slice(offset, offset + CHUNK_CHARS)
      offset += CHUNK_CHARS

      if (bracketed) {
        // Wrap each chunk to avoid long-running open bracketed paste blocks
        options.onWrite?.(`\x1b[200~${chunk}\x1b[201~`)
      } else {
        options.onWrite?.(chunk)
      }

      if (offset < prepared.length) {
        setTimeout(pasteNext, CHUNK_DELAY_MS)
      }
    }

    cancelActivePaste = () => {
      cancelled = true
    }
    pasteNext()
  }

  textarea.addEventListener("paste", handlePaste, { capture: true })
  return () => {
    cancelActivePaste?.()
    cancelActivePaste = null
    textarea.removeEventListener("paste", handlePaste, { capture: true })
  }
}

// ============================================================================
// Copy Handler (Trim Whitespace)
// ============================================================================

export function setupCopyHandler(xterm: CopyHandlerTerminal): () => void {
  const element = xterm.element
  if (!element) return () => {}

  const handleCopy = (event: ClipboardEvent) => {
    const selection = xterm.getSelection()
    if (!selection) return

    // Trim trailing whitespace from each line
    const trimmed = selection
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
    if (event.clipboardData) {
      event.preventDefault()
      event.clipboardData.setData("text/plain", trimmed)
    } else {
      // Wayland / some Linux environments: clipboardData is null on synthetic events
      void navigator.clipboard?.writeText(trimmed).catch(() => {})
    }
  }

  element.addEventListener("copy", handleCopy)
  return () => element.removeEventListener("copy", handleCopy)
}

// ============================================================================
// Drop Handler (File Path Paste)
// ============================================================================

/**
 * Parse file:// URIs from a text/uri-list string into filesystem paths.
 */
function parseFileUris(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file://"))
    .map((uri) => {
      // Remove the file:// prefix. On Windows, file URIs look like
      // file:///C:/path — we strip the leading slash for drive letters.
      let path = decodeURIComponent(uri.replace(/^file:\/\//, ""))
      // Windows drive-letter check: /C:/ → C:/
      if (/^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1)
      }
      return path
    })
}

function imageFile(file: File) {
  return file.type.startsWith("image/")
}

async function writeImage(file: File) {
  const writeClipboardImage = objectProperty(terminalApi(), "writeClipboardImage")
  if (typeof writeClipboardImage !== "function") return false
  const buf = await file.arrayBuffer().catch(() => undefined)
  if (!buf) return false
  return writeClipboardImage(buf)
}

export function setupDropHandler(
  _xterm: unknown,
  container: HTMLDivElement,
  options: {
    image?: "path" | "paste"
    onWrite: (data: string) => void
    isBracketedPasteEnabled?: () => boolean
  },
): () => void {
  const handleDragOver = (event: DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy"
    }
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()

    const dt = event.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files ?? [])

    // Determine synchronously whether we can extract paths, so we can
    // call stopPropagation before the microtask boundary.  If neither
    // strategy applies, let the event bubble to the document-level
    // handler (prompt-input attachments) instead of swallowing it.
    const api = terminalApi()
    const isElectron = !!api && files.length > 0
    const uriList = dt.getData("text/uri-list")
    const hasUris = !!uriList && parseFileUris(uriList).length > 0
    const canPaste = isElectron && (options.image ?? "path") === "paste" && files.length > 0 && files.every(imageFile)

    if (!isElectron && !hasUris && !canPaste) return

    // We can handle this drop, so keep the document-level prompt handler from
    // processing it a second time.
    event.stopPropagation()

    if (canPaste) {
      let ok = false
      for (const file of files) {
        const wrote = await writeImage(file)
        if (!wrote) continue
        ok = true
        options.onWrite("\x16")
      }
      if (ok) return
    }

    const paths: string[] = []

    // Strategy 1: Electron — use preload's webUtils.getPathForFile()
    if (isElectron && paths.length === 0) {
      const getDroppedFilePaths = objectProperty(api, "getDroppedFilePaths")
      if (typeof getDroppedFilePaths === "function") {
        const resolved = getDroppedFilePaths(files)
        if (Array.isArray(resolved)) {
          paths.push(...resolved.filter((item) => typeof item === "string"))
        }
      }
    }

    // Strategy 2: text/uri-list fallback (Finder/Explorer provide file:// URIs)
    if (paths.length === 0 && uriList) {
      paths.push(...parseFileUris(uriList))
    }

    if (paths.length === 0) return

    // Shell-escape and write
    const { quote } = await import("shell-quote")
    const escaped = paths.map((p) => quote([p])).join(" ")
    const bracketed = options.isBracketedPasteEnabled?.() ?? false

    if (bracketed) {
      options.onWrite(`\x1b[200~${escaped}\x1b[201~`)
    } else {
      options.onWrite(escaped)
    }
  }

  container.addEventListener("dragover", handleDragOver)
  container.addEventListener("drop", handleDrop)
  return () => {
    container.removeEventListener("dragover", handleDragOver)
    container.removeEventListener("drop", handleDrop)
  }
}
