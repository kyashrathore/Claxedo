import { createEffect, type Accessor } from "solid-js"

export function createPresentationReadyReporter(ready: Accessor<boolean>, report?: () => void) {
  let reported = false
  createEffect(() => {
    if (reported || !ready()) return
    reported = true
    report?.()
  })
}
