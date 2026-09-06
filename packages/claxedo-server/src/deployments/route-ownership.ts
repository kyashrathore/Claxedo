/**
 * One owner per route family, checked at composition time.
 *
 * An app is assembled from shared route modules plus deployment-specific
 * adapters, which is the arrangement where two contributors mount the same
 * path and nobody notices. Hono resolves the collision silently: handlers
 * match in registration order and the first to terminate the chain wins, so a
 * duplicate does not fail — one implementation becomes dead code, and which
 * one depends on the order the composition happens to run its mounts in.
 *
 * Deliberately not a test-only check: a composition error stops the process at
 * boot, where it is one line of output, rather than at the first request that
 * reaches the losing handler.
 *
 * Lives at the `deployments/` root because both compositions install it —
 * `createSignedControlPlaneApp` as "hosted-shared" and `createSelfHostedApp`
 * as "self-hosted-node" — and a rule that belongs to no single deployment does
 * not live in a directory named for one.
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
export type Mountable = { route(prefix: string, sub: unknown): unknown }

const rawRoute = new WeakMap<object, Mountable["route"]>()

/**
 * Wrap an app so every `route()` call is recorded against an owner.
 *
 * A wrapper rather than a helper each mount must remember to call: with several
 * dozen mounts across three compositions, a helper is a control that lasts
 * until the next mount. The same reasoning as the IPC caller guard in the
 * desktop package.
 */
export function withRouteOwnership<T extends Mountable>(app: T, ownership: RouteOwnership, owner: string): T {
  const original = rawRoute.get(app) ?? app.route.bind(app)
  rawRoute.set(app, original)
  app.route = ((prefix: string, sub: unknown) => {
    ownership.claim(prefix, owner)
    return original(prefix, sub)
  }) as T["route"]
  return app
}

/** Mount one explicitly composed contribution under its own route owner. */
export function mountOwnedRoute(
  app: Mountable,
  ownership: RouteOwnership,
  owner: string,
  prefix: string,
  sub: unknown,
): void {
  ownership.claim(prefix, owner)
  const mount = rawRoute.get(app) ?? app.route.bind(app)
  mount(prefix, sub)
}
