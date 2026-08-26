import { getOwner, useContext, type Context } from "solid-js"

/**
 * `useContext` for the "may not be provided" case.
 *
 * Solid 2 tightened `useContext`: called with no owner it throws
 * `NoOwnerError`, where Solid 1 returned the context's default. That breaks
 * every helper whose contract is "undefined when the provider is absent" — the
 * `useContext(Ctx) ?? undefined` shape now throws instead of yielding
 * undefined, and it throws in exactly the situation the `?? undefined` was
 * written for: a consumer reached outside a component tree (a submit handler
 * built in a plain test root, a module-scope factory).
 *
 * Every context that uses this helper declares an explicit default (`null`), so
 * the only failure mode left is the missing owner, and guarding on `getOwner()`
 * covers it precisely — no swallowing of unrelated errors.
 *
 * Consumers that REQUIRE their provider should keep calling `useContext`
 * directly and throw their own message; a hard failure there is correct.
 */
export function useContextOptional<T>(context: Context<T>): NonNullable<T> | undefined {
  if (!getOwner()) return undefined
  return useContext(context) ?? undefined
}
