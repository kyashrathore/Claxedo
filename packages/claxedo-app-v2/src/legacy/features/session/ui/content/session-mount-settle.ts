import { createMemo, createSignal, onCleanup } from "solid-js"

import { FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS } from "@/features/session/store/first-fold-prefetch"

/**
 * How long the gate waits for the transcript read the activating click started
 * before it builds the page anyway.
 *
 * It is the SAME budget the session controller gives that same read when it
 * joins it (`FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS`), deliberately: "how long an
 * activation waits for its first fold" is one policy, and a gate with its own
 * number would be a second, quietly disagreeing answer. Past it, waiting has
 * stopped being free — the controller is about to stop waiting too — so the
 * page is built with whatever the store holds, exactly as it is today.
 */
const SESSION_MOUNT_TRANSCRIPT_DEADLINE_MS = FIRST_FOLD_PREFETCH_JOIN_TIMEOUT_MS

/**
 * The door a session surface's page waits behind on its FIRST activation.
 *
 * A session switch is one synchronous store write in the rail's click handler,
 * and Solid flushes it inside the click task — so every surface that write
 * brings into the workbench is constructed there too: the destination
 * `SessionPage`, its composer, its controller projections. Measured on the
 * 12-cell session-switch probe, that construction is ~14 ms of the click task,
 * and it buys nothing, because of what it is racing:
 *
 *   pointerdown ─┬─ transcript read issued  (lands on the wire in ~7 ms)
 *                └─ click task: store write + WHOLE destination page
 *                                        ↓
 *                   the read's continuation is a queued task and cannot run
 *                   while that click task and its paint own the thread
 *                                        ↓
 *                   transcript settles → the timeline mounts, in a SECOND
 *                   construction pass, ~10 ms later
 *
 * So the page was built empty, could only render a skeleton, and was then
 * re-entered when its messages arrived — while being the very thing that
 * delayed them. Measured medians for a cold same-workspace switch: activation
 * batch ended at 35 ms, transcript settled at 66 ms, timeline mounted at 78 ms.
 *
 * This gate inverts the order. The click task does the state write and the
 * shell's acknowledgement; the transcript's continuation runs in the room that
 * leaves; and the page is then constructed ONCE, with its messages already in
 * hand, so its timeline mounts in the same pass instead of a later one.
 *
 * Three properties matter and are why this is a data gate rather than a frame
 * gate (a two-frame version of this was measured and REJECTED — see the
 * experiment note at the bottom of this file):
 *
 *  - It waits for the thing readiness actually binds on. Deferring by frames
 *    moves the construction later without moving the transcript, so the switch
 *    just finishes later.
 *  - It cannot make a surface appear sooner than it would have. Every path
 *    through it either constructs immediately or constructs after a read the
 *    old code was already waiting on, so it can only ever tell the truth about
 *    readiness.
 *  - It is per-surface and one-way. The decision is taken at the first
 *    activation and latched, so a retained surface coming back, and a later
 *    read going in flight under a live page, never re-close it.
 *
 * A surface with no read in flight — every warm switch, every restore of a
 * surface whose transcript is already cached — takes the immediate branch in
 * the same render pass, and pays nothing.
 */
export function createSessionMountSettle(input: {
  /** Whether this surface should be showing its page at all. */
  active: () => boolean
  /** The transcript read in flight for this surface's identity, if any. */
  pendingTranscript: () => Promise<unknown> | undefined
}): () => boolean {
  type Decision = { state: "open" } | { state: "waiting"; pending: Promise<unknown> }
  // The decision, and the read it is waiting on, are taken together on the
  // first activation and then latched by `previous`. Carrying the promise here
  // rather than re-reading it later is what makes the latch complete: there is
  // exactly one read this surface's construction waits for, chosen at the
  // moment the surface was activated.
  //
  // It is a memo, not an effect, so a surface with nothing to wait for answers
  // in the SAME render pass that asks — the warm path must not pay even one
  // extra pass, let alone a frame.
  const decision = createMemo<Decision | undefined>((previous) => {
    if (previous) return previous
    if (!input.active()) return undefined
    const pending = input.pendingTranscript()
    return pending ? { state: "waiting", pending } : { state: "open" }
  })
  const [released, setReleased] = createSignal(false)
  let stopWaiting: VoidFunction | undefined
  // Registered here, in the surface's own owner, so the wait is torn down with
  // the surface no matter which computation happened to start it.
  onCleanup(() => stopWaiting?.())
  const startWaiting = (pending: Promise<unknown>) => {
    let done = false
    const release = () => {
      if (done) return
      done = true
      setReleased(true)
    }
    const timer = setTimeout(release, SESSION_MOUNT_TRANSCRIPT_DEADLINE_MS)
    // Settled either way: a failed or superseded read is still an answer, and
    // the page renders whatever the store holds — exactly as it does today.
    void pending.then(release, release)
    stopWaiting = () => {
      done = true
      clearTimeout(timer)
    }
  }
  return () => {
    const current = decision()
    if (!current) return false
    if (current.state === "open") return true
    // The wait starts the first time someone asks. Starting it here rather than
    // in an effect keeps it in the same pass as the question — an effect would
    // start the clock a pass late, on the exact interaction whose passes this
    // gate exists to protect — and the only synchronous part is scheduling, so
    // nothing writes state while a render is reading it.
    if (!stopWaiting) startWaiting(current.pending)
    return released()
  }
}

/**
 * Measured rejection, kept so the cheaper-looking version is not retried.
 *
 * A fixed two-animation-frame gate (construct the page in the frame after the
 * click's paint) was implemented and run paired against the same build, three
 * pairs, 12 cells each. It did what it promised to the click task — the
 * activation batch fell from 35.4/32.8/33.7 ms to 21.6/18.7/21.9 ms across the
 * three cold blocks — and still lost, because the transcript moved with it:
 * its settlement went 66.4→70.5, 68.4→75.8 and 57.8→100.1 ms, and readiness
 * followed, 83.4 ms mean cold to 97.7 ms. Total main-thread work per switch was
 * unchanged; only the finish line moved. Deferral by frames cannot win here.
 * Reduction can, and waiting for the transcript is what removes a whole
 * construction pass rather than relocating one.
 */
