import { createMemo, untrack, type Accessor } from "solid-js"

export type ActiveLocationSnapshot = {
  pathname: string
  search: string
  hash: string
}

/**
 * Retained session surfaces keep their last owned route while hidden.
 *
 * The router location is global. If every retained SessionPage reads it
 * directly, one foreground navigation wakes route/workspace/composer memos in
 * every hidden page. Reading the source only while active removes those global
 * subscriptions; reactivation catches the surface up to the current location.
 */
export function createActiveLocationSnapshot(input: {
  active: Accessor<boolean>
  pathname: Accessor<string>
  search: Accessor<string>
  hash: Accessor<string>
}): Accessor<ActiveLocationSnapshot> {
  const read = (): ActiveLocationSnapshot => ({
    pathname: input.pathname(),
    search: input.search(),
    hash: input.hash(),
  })
  // Solid 2's `createMemo` takes options, not a seed value, in its second
  // argument: the first compute run receives `undefined` instead. `initial` is
  // still read untracked at creation so a memo created while inactive publishes
  // the location it was created at -- not `undefined` -- and still subscribes
  // to nothing.
  const initial = untrack(read)

  return createMemo((previous: ActiveLocationSnapshot | undefined) => {
    const last = previous ?? initial
    if (!input.active()) return last
    const next = read()
    if (next.pathname === last.pathname && next.search === last.search && next.hash === last.hash) return last
    return next
  })
}
