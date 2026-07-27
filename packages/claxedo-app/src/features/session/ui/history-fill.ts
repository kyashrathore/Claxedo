/**
 * Schedules the timeline's "there is not enough content to scroll" reveal.
 *
 * When the rendered history does not overflow the viewport the user can never
 * scroll up to reach older turns, so they have to be revealed for them. The
 * subtlety is WHEN that is safe to conclude.
 *
 * The measurement it depends on (`scrollHeight`) is only as current as the last
 * virtualizer pass — the virtualizer publishes the timeline's total height onto
 * the content element. A check that lands between "the message list grew" and
 * "the virtualizer re-measured" reads the height of the OLD, shorter list and
 * wrongly concludes the content does not fill the viewport. Acting on that
 * reading collapses an already-established render window, and because the window
 * only re-engages at hydrate the session then paints every turn at once for the
 * rest of its life.
 *
 * So the decision is confirmed across two consecutive frames. A stale reading
 * does not survive the next frame; a genuinely short conversation reads the same
 * on both and is still revealed, one frame later.
 */
export function createHistoryFill(input: { eligible: () => boolean; reveal: () => void }) {
  let frame: number | undefined

  const schedule = () => {
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!input.eligible()) return

      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!input.eligible()) return

        input.reveal()
      })
    })
  }

  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  return { schedule, cancel }
}
