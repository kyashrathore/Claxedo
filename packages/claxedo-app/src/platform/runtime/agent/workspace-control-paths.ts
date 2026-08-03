// Sandbox-driver control-plane paths, as the CLIENT builds them.
//
// This module is deliberately IMPORT-FREE. claxedo-server's
// `routes/sandbox-driver-routes.contract.test.ts` imports it by relative path
// to dispatch these exact paths through the real Hono router, the same way
// `doorbell-event-contract.test.ts` imports the app's event mirrors. Zero
// imports is what makes that legal: the server's vitest has no `@/` alias and
// no browser `define`s, so any import added here would break the contract test
// (and add a runtime edge from server to app). Keep the URL-building helpers
// that need `@/platform/api/api` in `workspace-control-routes.ts` instead.
//
// The server serves these under `/drivers` (see
// `packages/claxedo-server/src/sandbox/routes/sandbox-driver-routes.ts`), and
// `architecture.test.ts` pins that naming. The client previously said
// `/providers`, which 404'd against every one of these routes.

export const WORKSPACE_SANDBOX_DRIVERS_PATH = "/api/workspace/drivers"

export const WORKSPACE_DEFAULT_SANDBOX_DRIVER_PATH = "/api/workspace/drivers/default"

export function workspaceSandboxDriverAuthPath(driverId: string) {
  return `/api/workspace/drivers/${encodeURIComponent(driverId)}/auth`
}
