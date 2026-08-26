import { createMemo, type Accessor } from "solid-js"

/**
 * A pane-owned view of an authoritative reactive source.
 *
 * Retained panes stay mounted while hidden. Reading a query/store directly from
 * those panes leaves the entire UI projection graph subscribed to background
 * updates. This boundary keeps the last published value while inactive and
 * stops reading the source, so Solid removes those dependencies. The active
 * edge reads the authoritative source once and publishes its latest value.
 */
export function createActivePaneProjection<T>(input: {
  active: Accessor<boolean>
  read: Accessor<T>
  initial: T
}): Accessor<T> {
  // Solid 2's `createMemo` takes `MemoOptions` in its second argument, not a
  // seed value: the first compute receives `undefined` as the previous value,
  // so the seed lands as the compute's default parameter instead.
  return createMemo<T>((previous = input.initial) => {
    if (!input.active()) return previous
    return input.read()
  })
}
