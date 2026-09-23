import { createEffect } from "solid-js"

/**
 * Guarded access to a pane's pty row, plus a snapshot of its last known value.
 *
 * `local.pty` THROWS when the pane it belongs to has been detached, which is
 * ordinary during teardown rather than exceptional — so every read goes through
 * `safePty` and returns undefined instead of propagating. The snapshot exists for
 * the cleanup path, which needs the row's last known contents at a moment when
 * reading it live may already be impossible.
 *
 * Extracted from `terminal.tsx` to bring that file back under its size ceiling;
 * the seam is real, since neither piece touches the terminal backend or the DOM.
 */
export function createPtySnapshot<P extends object>(local: () => { pty: P }) {
  const safePty = (): P | undefined => {
    try {
      return local().pty
    } catch {
      return undefined
    }
  }

  // A shallow COPY, not the row itself: the row is a reactive store proxy whose
  // reads throw once the pane is gone, which is precisely when cleanup needs it.
  let snapshot: P | undefined = (() => {
    const pty = safePty()
    return pty ? { ...pty } : undefined
  })()

  createEffect(() => {
    const pty = safePty()
    if (pty) snapshot = { ...pty }
  })

  return { safePty, snapshot: () => snapshot }
}
