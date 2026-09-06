import type { JSX } from "solid-js"

/**
 * Calls a JSX handler prop, whichever of its two shapes the caller passed.
 *
 * `JSX.EventHandlerUnion` is either a plain function or a `[handler, data]`
 * pair that Solid invokes with the bound data first. `typeof` is the only
 * discriminator that narrows both arms: solid's `BoundEventHandler` is an
 * interface with numeric keys `0`/`1`, not a tuple, so `Array.isArray` cannot
 * narrow it and leaves the function arm needing an assertion to call.
 *
 * A no-op when `handler` is absent, so callers forward an optional prop
 * without a guard of their own.
 */
export function callEventHandler<T, E extends Event>(
  handler: JSX.EventHandlerUnion<T, E> | undefined,
  event: E & { currentTarget: T; target: globalThis.Element },
) {
  if (!handler) return
  if (typeof handler === "function") {
    handler(event)
    return
  }
  handler[0](handler[1], event)
}
