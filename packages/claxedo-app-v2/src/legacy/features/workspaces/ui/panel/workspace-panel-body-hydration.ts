import { createEffect, createSignal, onCleanup } from "solid-js"

/**
 * The second chunk of one panel body's construction, and the only thing that
 * schedules it.
 *
 * A panel body is built in two pieces rather than one task. The first — its
 * scopes, chrome and the box the content sits in — runs in the construction
 * task itself. The second — the review surface, which is effectively the whole
 * cost — runs after the first has painted, and this signal is its door.
 *
 * Chunking exists for the INTERRUPT. The construction door opens on the
 * shell's own two painted frames, which lands inside the window where a user
 * who has changed their mind clicks close, and one task holds that click for
 * its whole remainder. Two painted frames, the same measure `createShellSettle`
 * uses for the shell itself, is what separates the chunks: a callback on the
 * next frame runs BEFORE that frame paints, so the first chunk has not been
 * seen yet and the thread would be taken back inside the same frame it was
 * given up in. Waiting for the frame after gives the shell chunk a real
 * presentation, and gives an interrupting close a whole frame in which to be
 * heard before the expensive chunk starts at all.
 *
 * `ready` is the withdrawal, not just the trigger. A close or a switch away
 * arriving between the chunks cancels the pending frames and the body simply
 * stays a shell — there is no partial subtree to unwind, because the second
 * chunk never ran. It resumes the moment the body is the user's surface again,
 * so a reopen inside the close grace finishes the body it already has instead
 * of reconstructing it. Disposal needs no participation here: this lives
 * inside the body's own reactive root, so releasing the body cancels the
 * pending frames with it.
 */
export function createPanelBodyHydration(ready: () => boolean) {
  const [hydrated, setHydrated] = createSignal(false)
  // Arms the second chunk and hands back its canceller, so the effect below
  // stays pure control flow and every write to the door happens from a frame.
  const arm = () => {
    if (typeof requestAnimationFrame !== "function") {
      // No frame scheduler is no yield: chunking is a scheduling concern and
      // there is nothing to schedule against.
      setHydrated(true)
      return () => {}
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setHydrated(true))
    })
    return () => cancelAnimationFrame(frame)
  }
  createEffect(() => {
    if (hydrated() || !ready()) return
    onCleanup(arm())
  })
  return hydrated
}
