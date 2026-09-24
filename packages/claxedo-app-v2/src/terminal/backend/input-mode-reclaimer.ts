import type { IDisposable, Terminal as XTerm } from "@xterm/xterm"

const ESC = "\x1b"

export const SHELL_READY_OSC_ID = 777
export const SHELL_READY_MARKER_PAYLOAD = "claxedo-shell-ready"
export const KITTY_KEYBOARD_DISARM_SEQUENCE = `${ESC}[<255u${ESC}[=0;1u`

export type LeakableInputMode = "kitty" | "mouse" | "focus"

export const LEAKED_MODE_DISARM: Record<LeakableInputMode, string> = {
  kitty: KITTY_KEYBOARD_DISARM_SEQUENCE,
  mouse: `${ESC}[?1003l`,
  focus: `${ESC}[?1004l`,
}

export type LeakedInputModeReclaimer = {
  noteArm(mode: LeakableInputMode, armed: boolean): void
  noteShellReady(): void
  collectDisarm(): string
}

const MODES: readonly LeakableInputMode[] = ["kitty", "mouse", "focus"]

type ModeEntry = { armed: boolean; shellOwned: boolean; pending: boolean }

export function createLeakedInputModeReclaimer(): LeakedInputModeReclaimer {
  const state = new Map<LeakableInputMode, ModeEntry>(
    MODES.map((mode) => [mode, { armed: false, shellOwned: false, pending: false }]),
  )
  let sawMarker = false
  return {
    noteArm(mode, armed) {
      const entry = state.get(mode)
      if (!entry) return
      entry.armed = armed
      if (armed) {
        entry.pending = false
        if (!sawMarker) entry.shellOwned = true
      } else {
        entry.shellOwned = false
      }
    },
    noteShellReady() {
      sawMarker = true
      for (const entry of state.values()) {
        if (entry.armed && !entry.shellOwned) {
          entry.pending = true
          entry.armed = false
        }
      }
    },
    collectDisarm() {
      let disarm = ""
      for (const mode of MODES) {
        const entry = state.get(mode)
        if (!entry) continue
        if (entry.pending && !entry.armed) disarm += LEAKED_MODE_DISARM[mode]
        entry.pending = false
      }
      return disarm
    },
  }
}

function primary(param: number | number[]): number {
  return typeof param === "number" ? param : (param[0] ?? 0)
}

function decModes(reclaimer: LeakedInputModeReclaimer, params: (number | number[])[], armed: boolean): false {
  for (const param of params) {
    const mode = primary(param)
    if (mode === 1000 || mode === 1002 || mode === 1003) reclaimer.noteArm("mouse", armed)
    else if (mode === 1004) reclaimer.noteArm("focus", armed)
  }
  return false
}

function kittyHandlers(xterm: XTerm, reclaimer: LeakedInputModeReclaimer): IDisposable[] {
  return [
    xterm.parser.registerCsiHandler({ prefix: ">", final: "u" }, () => {
      reclaimer.noteArm("kitty", true)
      return false
    }),
    xterm.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      reclaimer.noteArm("kitty", primary(params[0] ?? 0) !== 0)
      return false
    }),
    xterm.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
      reclaimer.noteArm("kitty", false)
      return false
    }),
  ]
}

export function installInputModeReclaimer(xterm: XTerm): () => void {
  const reclaimer = createLeakedInputModeReclaimer()
  let scheduled = false
  const scheduleFlush = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const disarm = reclaimer.collectDisarm()
      if (disarm) xterm.write(disarm)
    })
  }
  const handlers: IDisposable[] = [
    ...kittyHandlers(xterm, reclaimer),
    xterm.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => decModes(reclaimer, params, true)),
    xterm.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => decModes(reclaimer, params, false)),
    xterm.parser.registerOscHandler(SHELL_READY_OSC_ID, (payload) => {
      if (payload !== SHELL_READY_MARKER_PAYLOAD) return false
      reclaimer.noteShellReady()
      scheduleFlush()
      return false
    }),
  ]
  return () => {
    for (const handler of handlers) handler.dispose()
  }
}
