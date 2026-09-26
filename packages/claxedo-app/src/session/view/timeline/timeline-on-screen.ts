import type { Accessor } from "solid-js"

export function whileOnScreen<T>(onScreen: Accessor<boolean>, read: (previous: T | undefined) => T) {
  return (previous: T | undefined): T => (previous !== undefined && !onScreen() ? previous : read(previous))
}
