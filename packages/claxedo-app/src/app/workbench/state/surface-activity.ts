import type { SetStoreFunction } from "solid-js/store"
import type { ClaxedoState } from "./types"

export type SurfaceActivityApi = {
  touch(contentId: string, now?: number): void
  /**
   * Call untracked: it reads the record it writes.
   *
   * Keep a tab across the idle cut while its agent works or waits for input.
   * Releasing the hold counts as use, so a result that landed while the user
   * was away gets a full idle window before it is closed.
   */
  hold(contentId: string, held: boolean, now?: number): void
}

// Each record is replaced whole: a path setter would merge into the old
// object and leave a released `held` behind.
export function createSurfaceActivitySlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): SurfaceActivityApi {
  const { state, setState } = input
  return {
    touch(contentId, now = Date.now()) {
      const held = state.activity[contentId]?.held
      setState("activity", { [contentId]: held ? { lastActiveAt: now, held } : { lastActiveAt: now } })
    },
    hold(contentId, held, now = Date.now()) {
      const current = state.activity[contentId]
      if (!!current?.held === held) return
      setState("activity", {
        [contentId]: held ? { lastActiveAt: current?.lastActiveAt ?? now, held: true } : { lastActiveAt: now },
      })
    },
  }
}
