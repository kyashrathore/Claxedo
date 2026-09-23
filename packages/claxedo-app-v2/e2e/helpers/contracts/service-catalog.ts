// CONTRACT BINDING: GET /api/claxedo/services
//
// The first-party service catalog for the signed principal. The app reads it as
// its own request rather than as a field of a boot aggregate — see
// `serviceCatalogUrl`/`fetchServiceCatalog` in src/app/boot/data/bootstrap.ts,
// whose result goes straight into `synchronizeServiceCatalogFromBootstrap`
// (src/app/composition/service-contributions.ts).
//
// Mirrors `signedServiceCatalogState` in
// packages/claxedo-server/src/routes/hosted/shell.ts (mounted at
// `.get("/api/claxedo/services", ...)`): the `{ authenticated, services }` pair
// is answered on EVERY outcome, never an error — `authenticated: false` is the
// authoritative sign-out the app deactivates loaded services on. The catalog is
// projected through the real producer so a descriptor-shape change fails here
// rather than being restated as a literal.
//
// The zero state is `EMPTY_SERVICE_CATALOG`, which is exactly what the real
// route answers when no `serviceCatalog` provider is composed — the Tier M mock
// composes none.
import {
  EMPTY_SERVICE_CATALOG,
  projectServiceCatalogForBrowser,
} from "@claxedo/service-contract"

export function serviceCatalogStateResponse(input?: { authenticated?: boolean; services?: unknown }) {
  if (input?.authenticated === false) return { authenticated: false, services: EMPTY_SERVICE_CATALOG }
  return {
    authenticated: true,
    services: projectServiceCatalogForBrowser(input?.services ?? EMPTY_SERVICE_CATALOG),
  }
}

/** `page.route` URL predicate for the service catalog read. */
export function isServiceCatalogPath(pathname: string) {
  return pathname === "/api/claxedo/services"
}
