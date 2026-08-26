import { createSignal, onCleanup } from "solid-js"
import type { JSX } from "@solidjs/web"

/**
 * How many constructed panel bodies the panel may hold at once: the displayed
 * one plus ONE recently-visited neighbour.
 *
 * Two is the smallest size that pays for the case it exists for. Cross-
 * workspace session switching is overwhelmingly a ping-pong between the
 * workspace the user is working in and the one they just came from; a size of
 * one is the old behaviour (every switch reconstructs), and every size above
 * two buys a rarer return for another whole workspace body held in memory.
 *
 * Memory boundedness, stated once and enforced by this module:
 *  - the bound is a COUNT, not a byte budget: at most `limit` live bodies
 *    exist at any moment, and constructing one past the limit disposes the
 *    least-recently-displayed body in the same call that inserts the new one;
 *  - a retained body is never the displayed one, and the panel hides it with
 *    `content-visibility: hidden` + `aria-hidden` + `inert`, so what is held
 *    is DOM and reactive graph — no rendering, paint, hit testing or
 *    accessibility surface;
 *  - `releaseAllExcept` drops the neighbour when the panel closes, so a closed
 *    panel never holds a workspace the user is not looking at;
 *  - the store disposes every body when its owner tears down. The workbench
 *    drops the whole panel shell after the close grace, so the closed panel's
 *    zero-DOM contract is unchanged by retention.
 */
export const WORKSPACE_PANEL_BODY_RETENTION = 2

export type RetainedPanelBody = {
  /** Content identity this body was constructed for. */
  key: string
  /** Whether this body is the one the panel currently displays. */
  displayed: () => boolean
  /**
   * Whether this body's second construction chunk has run. A body between its
   * chunks is a shell, so the panel keeps its placeholder over it.
   */
  hydrated: () => boolean
  element: JSX.Element
  dispose: VoidFunction
}

/**
 * The panel's bounded store of constructed bodies, keyed by content identity.
 *
 * Rendering order is INSERTION order and never changes while a body is live:
 * a retained host must not move in the DOM, or the layout state that
 * `content-visibility: hidden` preserves — the whole reason a return switch is
 * cheap — is thrown away on every switch. Recency is tracked separately and
 * only ever decides which body is evicted.
 */
export function createPanelBodyRetention(input?: { limit?: number }) {
  const limit = Math.max(1, input?.limit ?? WORKSPACE_PANEL_BODY_RETENTION)
  // `held` is the authority; `entries` is the rendering view of it. The store's
  // own methods run inside the panel's construction effect, and reading a
  // signal there would subscribe that effect to its own writes.
  let held: RetainedPanelBody[] = []
  const [entries, setEntries] = createSignal<RetainedPanelBody[]>(held)
  const commit = (next: RetainedPanelBody[]) => {
    held = next
    setEntries(next)
  }
  const [activeKey, setActiveKey] = createSignal("")
  // Most-recently-displayed first. Plain state, not a signal: nothing renders
  // from recency, and making it reactive would re-run the panel's construction
  // effect on every activation.
  let recency: string[] = []

  const touch = (key: string) => {
    recency = [key, ...recency.filter((value) => value !== key)]
  }
  const forget = (body: RetainedPanelBody) => {
    recency = recency.filter((value) => value !== body.key)
    body.dispose()
  }
  const release = () => {
    const current = held
    if (!current.length) return
    commit([])
    for (const body of current) forget(body)
  }
  onCleanup(release)

  return {
    entries,
    activeKey,
    /** Displayed-ness of one key, stable across activations — a body reads its own. */
    displayed: (key: string) => () => activeKey() === key,
    /**
     * Make `key` the displayed body. Returns whether a body for it is already
     * retained: `true` means the switch is finished — nothing to construct,
     * nothing to wait for — and `false` means the caller must build one.
     */
    activate: (key: string) => {
      touch(key)
      setActiveKey(key)
      return held.some((body) => body.key === key)
    },
    /**
     * Insert a freshly constructed body, evicting the least-recently-displayed
     * one if the store is full. The evicted body is disposed here, so a caller
     * that constructed a body has no separate teardown to remember.
     */
    retain: (body: RetainedPanelBody) => {
      touch(body.key)
      const current = held
      const stalest = [...recency]
        .reverse()
        .find((key) => key !== body.key && current.some((other) => other.key === key))
      const evicted =
        current.length < limit
          ? undefined
          : (current.find((candidate) => candidate.key === stalest) ??
            current.find((candidate) => candidate.key !== body.key))
      // Replacing the evicted body IN PLACE keeps every surviving body at its
      // own DOM index.
      commit(evicted ? current.map((candidate) => (candidate === evicted ? body : candidate)) : [...current, body])
      if (evicted) forget(evicted)
    },
    /** Drop every body except the one named — the panel's close path. */
    releaseAllExcept: (key: string) => {
      const current = held
      const kept = current.filter((body) => body.key === key)
      if (kept.length === current.length) return
      commit(kept)
      for (const body of current) if (body.key !== key) forget(body)
    },
    release,
  }
}
