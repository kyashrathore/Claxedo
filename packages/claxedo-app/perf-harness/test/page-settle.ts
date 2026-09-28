import type { ClockFrame, FrameLog, PageSettle } from "agent-app-benchmark/driver-sdk"

const READY = {
  displayedDestination: true,
  latestTurnPainted: true,
  noPlaceholder: true,
  firstFoldComplete: true,
  composerEditable: true,
  windowVisibleFocused: true,
}

/** A resolved page clock: `unready` frames before the destination paints, then the settle frame and its 30 confirming frames. */
export function resolvedSettle(input: { startAt: number; timeOrigin: number; unready: number }): PageSettle {
  const frames: ClockFrame[] = Array.from({ length: input.unready + 31 }, (_, index) => {
    const ready = index >= input.unready
    return {
      at: input.startAt + 8 * (index + 1),
      gates: ready ? READY : { ...READY, latestTurnPainted: false },
      signature: ready ? "settled" : null,
      mutated: false,
    }
  })
  return { startAt: input.startAt, settledAt: frames[input.unready]!.at, timeOrigin: input.timeOrigin, frames }
}

const frameworkRoot = new URL("../", import.meta.resolve("agent-app-benchmark/driver-sdk"))

/** The framework's own re-check of a reported clock against its frame log. */
export const { frameLogMismatch } = (await import(new URL("src/clock-rule.mjs", frameworkRoot).href)) as {
  frameLogMismatch: (frameLog: FrameLog, clock: { start: number; end: number }) => string | null
}
