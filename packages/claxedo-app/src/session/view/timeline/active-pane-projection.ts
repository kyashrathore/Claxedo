import { createMemo, type Accessor } from "solid-js"

export function createActivePaneProjection<T>(input: {
  active: Accessor<boolean>
  read: Accessor<T>
  initial: T
}): Accessor<T> {
  return createMemo((previous: T) => {
    if (!input.active()) return previous
    return input.read()
  }, input.initial)
}
