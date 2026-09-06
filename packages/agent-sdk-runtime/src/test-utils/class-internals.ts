/**
 * Test-only typing helpers for harness-adapter doubles.
 *
 * Several suites in this package fabricate an adapter with
 * `Object.create(Adapter.prototype)` — deliberately skipping the constructor —
 * and then drive the double's internals (`store`, `sessions`, `options`, …)
 * and call non-public methods on it.
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
 *
 * These apply only to a double fabricated by `Object.create`, whose value starts
 * out untyped. They are not a way into a *real* instance: reaching a real one's
 * `protected` members is what a subclass is for, as `AcpHarnessAdapter`'s tests
 * do. A helper generic in the type it returns is not an alternative — it asserts
 * whatever the caller names, so it checks nothing.
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
 * A stand-in for the global `fetch`. The platform type is callable *and* carries
 * `preconnect`, so a bare arrow function is not assignable to it; this attaches an
 * inert one rather than casting the check away.
 */
export function fakeGlobalFetch(
  handler: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(handler, { preconnect: () => {} })
}
