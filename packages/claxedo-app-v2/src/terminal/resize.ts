import type { TerminalSize } from "@/server"
import type { TerminalBackend } from "./backend/types"

const MIN_HOST_WIDTH = 48
const MIN_HOST_HEIGHT = 32
const MIN_ROWS = 2
const CELL_WIDTH = 7
const CORRUPT_COL_RATIO = 0.35
const DESYNC_THRESHOLD = 3
const DESYNC_COOLDOWN_MS = 1500
const RESIZE_DEBOUNCE_MS = 100
const OPEN_SETTLE_MS = 220
const AGENT_TUI = /\b(?:codex|claude|opencode|gemini|cursor-agent|cursor)\b/i

type Rect = { readonly width: number; readonly height: number }

export function hostStable(rect: Rect): boolean {
  return rect.width >= MIN_HOST_WIDTH && rect.height >= MIN_HOST_HEIGHT
}

export function sizeSane(size: TerminalSize, rect: Rect): boolean {
  if (size.cols < 2 || size.rows < MIN_ROWS) return false
  const expectedCols = Math.max(2, Math.floor(rect.width / CELL_WIDTH))
  return size.cols >= Math.max(2, Math.floor(expectedCols * CORRUPT_COL_RATIO))
}

export function sigwinchToggle(size: TerminalSize): readonly TerminalSize[] {
  const cols = Math.max(2, size.cols)
  return [
    { cols: Math.max(2, cols - 1), rows: size.rows },
    { cols, rows: size.rows },
  ]
}

export function isLikelyTui(input: { command?: string; title?: string }): boolean {
  return AGENT_TUI.test(input.command ?? "") || AGENT_TUI.test(input.title ?? "")
}

export type ResizePublisher = {
  readonly onOpen: () => void
  readonly dispose: () => void
}

export function createResizePublisher(input: {
  backend: TerminalBackend
  host: HTMLElement
  likelyTui: boolean
  publish: (size: TerminalSize) => Promise<void>
  onPublishFailed: (error: unknown) => void
}): ResizePublisher {
  const { backend } = input
  let debounce: number | undefined
  let settle: number | undefined
  let pending: TerminalSize | undefined
  let last: TerminalSize | undefined
  let suspect = 0
  let lastRecovery = 0
  let holdUntil = 0

  const publish = (size: TerminalSize, force = false) => {
    if (!force && last && last.cols === size.cols && last.rows === size.rows) return
    last = size
    input.publish(size).catch(input.onPublishFailed)
  }

  const recoverDesync = () => {
    const now = Date.now()
    if (suspect < DESYNC_THRESHOLD || now - lastRecovery < DESYNC_COOLDOWN_MS) return
    lastRecovery = now
    suspect = 0
    backend.fit()
    if (backend.rows > 0) backend.refresh(0, backend.rows - 1)
    for (const size of sigwinchToggle({ cols: backend.cols, rows: backend.rows })) publish(size, true)
  }

  const scheduleSettled = () => {
    if (settle !== undefined) window.clearTimeout(settle)
    settle = window.setTimeout(() => {
      settle = undefined
      holdUntil = 0
      publish(pending ?? { cols: backend.cols, rows: backend.rows })
    }, OPEN_SETTLE_MS)
  }

  const onResized = () => {
    if (!pending) return
    const rect = input.host.getBoundingClientRect()
    if (!hostStable(rect) || !sizeSane(pending, rect)) {
      suspect += 1
      recoverDesync()
      return
    }
    suspect = 0
    if (holdUntil > Date.now()) {
      scheduleSettled()
      return
    }
    publish(pending)
  }

  const disposeResize = backend.onResize((size) => {
    pending = size
    if (debounce !== undefined) window.clearTimeout(debounce)
    debounce = window.setTimeout(onResized, RESIZE_DEBOUNCE_MS)
  })

  return {
    onOpen: () => {
      backend.fit()
      if (!input.likelyTui) {
        holdUntil = Date.now() + OPEN_SETTLE_MS
        scheduleSettled()
        return
      }
      holdUntil = 0
      if (settle !== undefined) window.clearTimeout(settle)
      settle = undefined
      const [first, second] = sigwinchToggle({ cols: backend.cols, rows: backend.rows })
      input
        .publish(first)
        .then(() => input.publish(second))
        .catch(input.onPublishFailed)
    },
    dispose: () => {
      disposeResize()
      if (debounce !== undefined) window.clearTimeout(debounce)
      if (settle !== undefined) window.clearTimeout(settle)
    },
  }
}
