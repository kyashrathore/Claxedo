import { createRoot } from "solid-js"

/**
 * Build reactive state under an owner, then drive it from OUTSIDE that owner.
 *
 * Solid 2's dev build throws `REACTIVE_WRITE_IN_OWNED_SCOPE` when a signal or
 * store setter runs with an owner on the stack — the guard that catches a
 * component body or a memo writing state it also reads. Production code obeys
 * this for free: setters fire from DOM event handlers, stream callbacks and
 * timers, none of which restore an owner.
 *
 * A test written as `createRoot((dispose) => { ...whole test... })` does NOT:
 * the root owner stays current for every line, so every setter call the test
 * makes trips the guard, and the test exercises an ownership shape that never
 * occurs at runtime. Splitting it fixes both — the factory runs inside the root
 * so its memos and effects get an owner to clean up, and the test body runs
 * after `createRoot` has returned, exactly like the app's event handlers.
 *
 * ```ts
 * const [control, dispose] = mountReactive(() => createComposerAutoAccept(deps))
 * try {
 *   control.toggle()
 * } finally {
 *   dispose()
 * }
 * ```
 *
 * Effects still need an explicit `flush()`; this helper only owns ownership.
 */
export function mountReactive<T>(build: () => T): readonly [T, () => void] {
  let value!: T
  const dispose = createRoot((dispose) => {
    value = build()
    return dispose
  })
  return [value, dispose] as const
}
