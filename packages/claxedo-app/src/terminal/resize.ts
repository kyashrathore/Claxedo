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

type ResizePublisherInput = {
  backend: TerminalBackend
  host: HTMLElement
  likelyTui: boolean
  publish: (size: TerminalSize) => Promise<void>
  onPublishFailed: (error: unknown) => void
}

type ResizePublisherState = {
  readonly input: ResizePublisherInput
  debounce: number | undefined
  settle: number | undefined
  pending: TerminalSize | undefined
  last: TerminalSize | undefined
  suspect: number
  lastRecovery: number
  holdUntil: number
}

function backendSize(backend: TerminalBackend): TerminalSize {
  return { cols: backend.cols, rows: backend.rows }
}

function publishSize(state: ResizePublisherState, size: TerminalSize, force = false): void {
  if (!force && state.last && state.last.cols === size.cols && state.last.rows === size.rows) return
  state.last = size
  state.input.publish(size).catch(state.input.onPublishFailed)
}

function recoverDesync(state: ResizePublisherState): void {
  const now = Date.now()
  if (state.suspect < DESYNC_THRESHOLD || now - state.lastRecovery < DESYNC_COOLDOWN_MS) return
  state.lastRecovery = now
  state.suspect = 0
  const { backend } = state.input
  backend.fit()
  if (backend.rows > 0) backend.refresh(0, backend.rows - 1)
  for (const size of sigwinchToggle(backendSize(backend))) publishSize(state, size, true)
}

function clearSettle(state: ResizePublisherState): void {
  if (state.settle !== undefined) window.clearTimeout(state.settle)
  state.settle = undefined
}

function clearDebounce(state: ResizePublisherState): void {
  if (state.debounce !== undefined) window.clearTimeout(state.debounce)
  state.debounce = undefined
}

function scheduleSettled(state: ResizePublisherState): void {
  clearSettle(state)
  state.settle = window.setTimeout(() => {
    state.settle = undefined
    state.holdUntil = 0
    publishSize(state, state.pending ?? backendSize(state.input.backend))
  }, OPEN_SETTLE_MS)
}

function publishResized(state: ResizePublisherState): void {
  if (!state.pending) return
  const rect = state.input.host.getBoundingClientRect()
  if (!hostStable(rect) || !sizeSane(state.pending, rect)) {
    state.suspect += 1
    recoverDesync(state)
    return
  }
  state.suspect = 0
  if (state.holdUntil > Date.now()) {
    scheduleSettled(state)
    return
  }
  publishSize(state, state.pending)
}

function debounceResize(state: ResizePublisherState, size: TerminalSize): void {
  state.pending = size
  clearDebounce(state)
  state.debounce = window.setTimeout(() => publishResized(state), RESIZE_DEBOUNCE_MS)
}

function openShell(state: ResizePublisherState): void {
  state.holdUntil = Date.now() + OPEN_SETTLE_MS
  scheduleSettled(state)
}

function openTui(state: ResizePublisherState): void {
  state.holdUntil = 0
  clearSettle(state)
  const { input } = state
  const [first, second] = sigwinchToggle(backendSize(input.backend))
  input
    .publish(first)
    .then(() => input.publish(second))
    .catch(input.onPublishFailed)
}

export function createResizePublisher(input: ResizePublisherInput): ResizePublisher {
  const state: ResizePublisherState = {
    input,
    debounce: undefined,
    settle: undefined,
    pending: undefined,
    last: undefined,
    suspect: 0,
    lastRecovery: 0,
    holdUntil: 0,
  }
  const disposeResize = input.backend.onResize((size) => debounceResize(state, size))
  return {
    onOpen: () => {
      input.backend.fit()
      if (input.likelyTui) openTui(state)
      else openShell(state)
    },
    dispose: () => {
      disposeResize()
      clearDebounce(state)
      clearSettle(state)
    },
  }
}
