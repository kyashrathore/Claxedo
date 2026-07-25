import type { IDisposable, Terminal as XTerm } from "@xterm/xterm"
import {
  createLeakedInputModeReclaimer,
  SHELL_READY_MARKER_PAYLOAD,
  SHELL_READY_OSC_ID,
} from "../leaked-input-mode-reclaim"

/**
 * Wires xterm's parser to the leaked-input-mode reclaimer.
 *
 * We stream PTY output straight into this xterm, so nothing on the host sees
 * the mode traffic — the reclaim has to observe it here. Parser handlers are
 * exact and chunk-safe by construction (xterm reassembles sequences split
 * across writes), which is why this hooks the parser rather than scanning the
 * raw string.
 *
 * Every handler returns `false` so xterm still applies the sequence itself; we
 * are observing, not intercepting.
 *
 * The disarm is written on a microtask rather than inline, so a TUI that arms
 * its modes immediately after the prompt marker in the SAME parse (`fg` after
 * `^Z`, or a command launched from the prompt) has already been recorded by
 * the time we decide — and keeps its modes.
 */
export function installInputModeReclaimer(terminal: XTerm): IDisposable {
  const reclaimer = createLeakedInputModeReclaimer()
  const parser = terminal.parser
  const disposables: IDisposable[] = []
  let scheduled = false

  const scheduleFlush = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      const disarm = reclaimer.collectDisarm()
      if (!disarm) return
      // Written to the TERMINAL, not the pty: these sequences configure the
      // emulator's own reporting state, which is what leaked.
      try {
        terminal.write(disarm)
      } catch {
        // A disposed terminal is not worth surfacing.
      }
    })
  }

  // --- kitty keyboard protocol -------------------------------------------
  // `CSI > flags u` pushes/arms, `CSI = flags ; mode u` sets (0 disarms),
  // `CSI < n u` pops/disarms.
  disposables.push(
    parser.registerCsiHandler({ prefix: ">", final: "u" }, () => {
      reclaimer.noteArm("kitty", true)
      return false
    }),
  )
  disposables.push(
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const raw = params[0]
      const flags = typeof raw === "number" ? raw : (raw?.[0] ?? 0)
      reclaimer.noteArm("kitty", flags !== 0)
      return false
    }),
  )
  disposables.push(
    parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
      reclaimer.noteArm("kitty", false)
      return false
    }),
  )

  // --- mouse tracking (?1000/1002/1003) and focus reporting (?1004) -------
  const applyDecMode = (params: (number | number[])[], armed: boolean) => {
    for (const param of params) {
      const primary = typeof param === "number" ? param : param[0]
      if (primary === 1000 || primary === 1002 || primary === 1003) {
        reclaimer.noteArm("mouse", armed)
      } else if (primary === 1004) {
        reclaimer.noteArm("focus", armed)
      }
    }
  }
  disposables.push(
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      applyDecMode(params, true)
      return false
    }),
  )
  disposables.push(
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      applyDecMode(params, false)
      return false
    }),
  )

  // --- our private prompt marker ------------------------------------------
  disposables.push(
    parser.registerOscHandler(SHELL_READY_OSC_ID, (payload) => {
      // OSC 777 is a general-purpose slot; only OUR payload means "shell owns
      // the foreground". Anything else on 777 is somebody else's.
      if (payload !== SHELL_READY_MARKER_PAYLOAD) return false
      reclaimer.noteShellReady()
      scheduleFlush()
      return false
    }),
  )

  return {
    dispose() {
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {}
      }
      disposables.length = 0
    },
  }
}
