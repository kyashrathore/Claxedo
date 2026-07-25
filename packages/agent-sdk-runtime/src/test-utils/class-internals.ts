/**
 * Test-only typing helpers for harness-adapter doubles.
 *
 * Several suites in this package fabricate an adapter with
 * `Object.create(Adapter.prototype)` — deliberately skipping the constructor —
 * and then drive the instance's internals (`store`, `sessions`, `options`, …)
 * and call private methods directly.
 *
 * The obvious spelling, `Adapter & { store: … }`, does not work: TypeScript
 * reduces an intersection to `never` as soon as one constituent declares a
 * member with the same name `private`. That reduction was invisible while
 * `src/**\/*.test.ts` was excluded from the typecheck (every property access on
 * `never` is legal), so the casts read as if they typed something.
 *
 * Mapping over `keyof T` keeps only the public surface — private and protected
 * members are not in `keyof` — which leaves the double free to describe exactly
 * the internals it reaches for.
 */
export type PublicSurface<T> = { [K in keyof T]: T[K] }

/** An instance fabricated for a test: its public surface plus the internals the test drives. */
export type WithInternals<T, Internals> = PublicSurface<T> & Internals

/**
 * Like `WithInternals`, but the named members *replace* `T`'s public ones instead
 * of intersecting with them. Needed when a test stubs a public method with a
 * signature the declared one does not admit — intersecting there produces a
 * member nothing can be assigned to.
 */
export type WithOverrides<T, Overrides> = Omit<PublicSurface<T>, keyof Overrides> & Overrides

/**
 * A view of a *real* instance's private state.
 *
 * `WithInternals` only works when the value starts out untyped (the `any` from
 * `Object.create`). When the test constructs the adapter for real, the source
 * type carries the `private` modifiers, and no assignment or `as` can widen them
 * away — TypeScript has no notion of a friend declaration. Crossing that
 * boundary is the point of these tests, so it happens here, once, named.
 */
export function internalsOf<Internals extends object>(instance: object): Internals {
  return instance as unknown as Internals
}

/**
 * A `setInterval` stand-in that schedules nothing and always hands back
 * `sentinel`, so a test can assert the exact handle reached `clearInterval`.
 *
 * The cast lives here rather than at each call site: the global `setInterval` is
 * an overload set whose signatures disagree on the handle type (`number`,
 * `Timer`, `Timeout`), so no honestly-typed stub is assignable to all of them,
 * and the sentinel is deliberately not any of them — the stubbed clock never
 * looks inside it.
 */
/**
 * A stand-in for the global `fetch`. The platform type is callable *and* carries
 * `preconnect`, so a bare arrow function is not assignable to it; this attaches an
 * inert one rather than casting the check away.
 */
export function fakeGlobalFetch(
  handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect: () => {} })
}

export function fakeSetInterval(
  sentinel: unknown,
  onSchedule?: (handler: () => void) => void,
): typeof globalThis.setInterval {
  return ((handler: unknown) => {
    onSchedule?.(handler as () => void)
    return sentinel
  }) as unknown as typeof globalThis.setInterval
}
