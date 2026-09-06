import type { SetStoreFunction, Store } from "solid-js/store"

/**
 * The two things you cannot do to a Solid store without an assertion.
 *
 * `SetStoreFunction<T>` is not one call signature — it is nine overloads whose
 * argument lists are derived from `T`'s own shape (path, path/path, filter
 * function, updater, …). TypeScript can neither erase `T` from it nor rebuild
 * it around a wrapper: `(...args: unknown[]) => unknown` is assignable to none
 * of the overloads, and no generic wrapper can reconstruct all nine.
 *
 * Both claims are true by construction — the value is the same setter, only
 * its declared type moves — and both were previously restated at four call
 * sites (`persistence/persist.ts` twice, `workbench/state/provider.tsx`
 * twice), where the reader had to re-derive the argument from a one-line
 * comment. They live here now, in a module whose whole job is to make them.
 */

/** Erase the element type of a store tuple for a library that takes `unknown`. */
export function eraseStoreTuple<T>(
  store: [Store<T>, SetStoreFunction<T>],
): [Store<unknown>, SetStoreFunction<unknown>] {
  // SetStoreFunction<T>'s nine overloads are derived from T's own shape, so no
  // declared type erases T from them; `restoreStoreTuple` puts the T back.
  // as-any: inexpressible, not lazy — see this module's header.
  return store as unknown as [Store<unknown>, SetStoreFunction<unknown>]
}

/** Restore the element type `eraseStoreTuple` erased. */
export function restoreStoreTuple<T>(
  state: Store<unknown>,
  setState: SetStoreFunction<unknown>,
): [Store<T>, SetStoreFunction<T>] {
  return [state as Store<T>, setState as SetStoreFunction<T>]
}

/**
 * A setter that runs `after` with the same arguments once the write lands.
 *
 * The wrapper is variadic because the overload set is: it forwards whatever it
 * was handed and returns whatever the setter returned, so every overload keeps
 * working at runtime even though none of them can be stated here.
 */
export function wrapSetStore<T>(
  setState: SetStoreFunction<T>,
  after: (args: unknown[]) => void,
): SetStoreFunction<T> {
  // Nothing is assignable to all nine overloads, so forwarding variadically is
  // the only shape that keeps every one working. as-any: see module header.
  const raw = setState as unknown as (...args: unknown[]) => unknown
  return ((...args: unknown[]) => {
    const result = raw(...args)
    after(args)
    return result
    // as-any: no generic wrapper can reconstruct the nine overloads, so the
  }) as unknown as SetStoreFunction<T> // forwarder is re-declared as what it forwards to.
}
