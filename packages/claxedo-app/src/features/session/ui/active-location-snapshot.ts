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
  const initial = untrack(read)

  return createMemo((previous: ActiveLocationSnapshot) => {
    if (!input.active()) return previous
    const next = read()
    if (
      next.pathname === previous.pathname &&
      next.search === previous.search &&
      next.hash === previous.hash
    ) return previous
    return next
  }, initial)
}
