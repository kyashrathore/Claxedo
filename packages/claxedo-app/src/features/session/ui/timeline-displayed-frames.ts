type FrameToken = number

/**
 * A per-frame loop that only spends frames while its surface is DISPLAYED.
 *
 * Session surfaces stay MOUNTED after the workbench stashes them — an activated
 * page is kept so a return switch is a display flip rather than a rebuild (see
 * session-content.tsx) — and the stash hides them with `content-visibility:
 * hidden` + `contain: strict`. That display lock stops style, layout and paint.
 * It does NOT stop JavaScript. Every `requestAnimationFrame` loop a stashed
 * timeline owns keeps running at full frame rate against an element that no
 * longer has layout, so it never reaches the settled measurement that would end
 * it early: it runs to its whole frame budget, and re-arms the next time its
 * surface is touched. With `MAX_OPEN_SURFACES` retained sessions that is a
 * per-session animation loop burning renderer CPU for work nobody can see —
 * measured as the dominant term in the packaged app's ending-idle CPU after a
 * session-switch workload.
 *
 * The loop READS the displayed authority rather than being told about it, so it
 * cannot drift out of sync with the surface: every arm and every frame re-checks.
 * A stashed surface parks — the step is kept, not dropped — because the work
 * these loops do (restoring the row the reader was on) is exactly what a return
 * switch needs. `resume()` is how a re-displayed surface starts spending frames
 * again; it is a no-op for a loop that is not parked.
 */
export function createDisplayedFrameLoop(input: {
  /** Whether this loop's surface is the one being shown. */
  displayed: () => boolean
  /** Frame seam for tests; tokens are opaque to the loop. */
  scheduleFrame?: (callback: () => void) => FrameToken
  cancelFrame?: (token: FrameToken) => void
}) {
  const scheduleFrame = input.scheduleFrame ?? requestAnimationFrame
  const cancelFrame = input.cancelFrame ?? cancelAnimationFrame
  let frame: FrameToken | undefined
  let step: (() => boolean) | undefined

  const arm = () => {
    if (frame !== undefined || step === undefined || !input.displayed()) return
    frame = scheduleFrame(() => {
      frame = undefined
      if (step === undefined) return
      // Re-checked here as well as in `arm`: the surface can be stashed after
      // this frame was already scheduled, and that frame must not run the step.
      if (!input.displayed()) return
      // The step decides when the work is finished; the loop only decides
      // whether a frame is spent on it at all.
      if (!step()) {
        step = undefined
        return
      }
      arm()
    })
  }

  return {
    /** Replace any running loop with `next`, which returns false when done. */
    start(next: () => boolean) {
      if (frame !== undefined) {
        cancelFrame(frame)
        frame = undefined
      }
      step = next
      arm()
    },
    /** Spend frames again on a parked step. No-op unless parked and displayed. */
    resume() {
      arm()
    },
    /** Drop the loop entirely — the work is no longer wanted. */
    stop() {
      step = undefined
      if (frame === undefined) return
      cancelFrame(frame)
      frame = undefined
    },
    /** True while a step is owned, whether or not a frame is currently armed. */
    get running() {
      return step !== undefined
    },
    /** True only while a frame is actually scheduled. */
    get scheduled() {
      return frame !== undefined
    },
  }
}
