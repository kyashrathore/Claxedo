import type { IDisposable, Terminal as XTerm } from "@xterm/xterm"

export type TerminalModes = {
  readonly applicationCursorKeys: boolean
  readonly bracketedPaste: boolean
  readonly alternateScroll: boolean
  readonly alternateScreen: boolean
  readonly mouseTracking: boolean
}

export type ModeTracker = {
  readonly modes: () => TerminalModes
  readonly reset: () => void
  readonly dispose: () => void
}

const ALTERNATE_SCROLL = 1007

function primary(param: number | number[]): number {
  return typeof param === "number" ? param : (param[0] ?? 0)
}

export function createModeTracker(xterm: XTerm): ModeTracker {
  let alternateScroll = false
  const handlers: IDisposable[] = [
    xterm.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.some((param) => primary(param) === ALTERNATE_SCROLL)) alternateScroll = true
      return false
    }),
    xterm.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.some((param) => primary(param) === ALTERNATE_SCROLL)) alternateScroll = false
      return false
    }),
  ]
  return {
    modes: () => ({
      applicationCursorKeys: xterm.modes.applicationCursorKeysMode,
      bracketedPaste: xterm.modes.bracketedPasteMode,
      alternateScroll,
      alternateScreen: xterm.buffer.active.type === "alternate",
      mouseTracking: xterm.modes.mouseTrackingMode !== "none",
    }),
    reset: () => {
      alternateScroll = false
    },
    dispose: () => {
      for (const handler of handlers) handler.dispose()
    },
  }
}
