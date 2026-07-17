import type * as Events from "@/app/integrations/claxedo-events"

/**
 * The app-shell capabilities WorkGraph consumes, injected by
 * `app/integrations/feature-ports.ts` (the same seam Session / Documents /
 * Workspaces use). The import above is TYPE-ONLY on purpose: `features/*` may
 * depend only on `platform`, `ui`, and `lib` (see architecture/ownership.ts), so
 * the shell binds the implementation at runtime instead.
 *
 * WorkGraph needs exactly one thing from the shell: the central Claxedo events
 * bus, where the server publishes the `workgraph.changed` doorbell that replaced
 * the deleted `GET /api/workgraph/changes` long-poll (plan 2026-07-17-004).
 */
export type WorkGraphAppPorts = {
  useClaxedoEventsOptional: typeof Events.useClaxedoEventsOptional
}

let ports: WorkGraphAppPorts | undefined

export function configureWorkGraphAppPorts(value: WorkGraphAppPorts) {
  ports = value
}

/**
 * Wave 3 wired this port in BOTH `app/integrations/feature-ports.ts` (production)
 * and `app/integrations/test-support/app-ports-stub.ts` (tests) — the doorbell is
 * live, not inert. The accessor stays tolerant anyway, for the reason below.
 *
 * Deliberately tolerant — it never throws for an unconfigured port, unlike the
 * other features' `bind()`ed accessors. The doorbell is an ACCELERATOR layered
 * on top of unconditional revalidation (route activation / tab-visible /
 * stream reconnect), never the only path to currency, so a WorkGraph rendered
 * without the shell (its own unit tests, which inject their own bus) must still
 * work rather than crash. Mirrors `useClaxedoEventsOptional`'s own contract,
 * which already returns `undefined` outside a `ClaxedoEventsProvider`.
 */
export function useClaxedoEventsOptional() {
  return ports?.useClaxedoEventsOptional()
}
