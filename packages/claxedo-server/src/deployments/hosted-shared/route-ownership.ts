/**
 * One owner per route family, checked at composition time.
 *
 * Unit 7 splits the signed control-plane routes from the boot wrapper, so the
 * same app will be assembled from a shared core plus deployment-specific
 * adapters. That is exactly the arrangement where two contributors mount the
 * same path and nobody notices.
 *
 * Hono resolves the collision silently: handlers match in registration order
 * and the first to terminate the chain wins. So a duplicate does not fail — it
 * produces an app where one of the two implementations is dead code, and which
 * one depends on the order a composition function happens to run its mounts in.
 * Rebuilding that composition in a different order changes behaviour with no
 * diff to any handler.
 *
 * The failure this prevents is not hypothetical for this refactor: the
 * self-hosted app is being recomposed from pieces that currently live in one
 * file, and "the local-execution adapter also mounts /api/claxedo/config" is
 * the shape of the mistake.
 *
 * Deliberately not a test-only check. A composition error should stop the
 * process at boot, where it is one line of output, rather than at the first
 * request that happens to reach the losing handler.
 */

/** A mounted family: the prefix, and who mounted it. */
export type RouteMount = { prefix: string; owner: string }

export class DuplicateRouteOwner extends Error {}

/**
 * Records mounts and refuses a second owner for the same prefix.
 *
 * Prefix equality, not overlap. `/api/workspace` and `/api/workspace/:id/...`
 * legitimately coexist — the hosted workspace routes and the checkpoint routes
 * are mounted separately today and both work, because Hono composes them. What
 * must not happen is two owners claiming the SAME mount point, where one
 * silently shadows the other.
 */
export function createRouteOwnership() {
  const mounts = new Map<string, string>()

  return {
    /** Claim a prefix. Throws if someone already owns it. */
    claim(prefix: string, owner: string) {
      const existing = mounts.get(prefix)
      if (existing !== undefined && existing !== owner) {
        throw new DuplicateRouteOwner(
          `route prefix "${prefix}" is claimed by both "${existing}" and "${owner}";`
          + " Hono would silently keep whichever mounted first",
        )
      }
      // Re-claiming by the SAME owner is allowed: a composition that mounts two
      // route objects under one prefix (as the hosted app does for
      // /api/workspace) is one owner making one decision.
      mounts.set(prefix, owner)
    },

    owner: (prefix: string) => mounts.get(prefix),

    /** Every claim, for a contract test to compare against a declared table. */
    mounts: (): RouteMount[] =>
      [...mounts.entries()].map(([prefix, owner]) => ({ prefix, owner })).toSorted((a, b) => a.prefix.localeCompare(b.prefix)),
  }
}

export type RouteOwnership = ReturnType<typeof createRouteOwnership>

/** The `app.route()` shape this wraps. */
export type Mountable = { route: (prefix: string, sub: never) => unknown }

/**
 * Wrap an app so every `route()` call is recorded against an owner.
 *
 * A wrapper rather than a helper each mount must remember to call: with several
 * dozen mounts across three compositions, a helper is a control that lasts
 * until the next mount. The same reasoning as the IPC caller guard in the
 * desktop package.
 */
export function withRouteOwnership<T extends Mountable>(app: T, ownership: RouteOwnership, owner: string): T {
  const original = app.route.bind(app)
  app.route = ((prefix: string, sub: never) => {
    ownership.claim(prefix, owner)
    return original(prefix, sub)
  }) as T["route"]
  return app
}
