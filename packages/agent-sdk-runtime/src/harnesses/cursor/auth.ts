import { isProviderUnavailable, type ProviderProjection } from "../../provider-projection"

/** The environment variable the installed SDK reads; `CURSOR_API_ENDPOINT` is not it. */
export const CURSOR_BACKEND_URL_ENV = "CURSOR_BACKEND_URL"

/**
 * The projections this harness consumes. Every other provider in the map
 * belongs to a different harness and is ignored, so an account bound for Claude
 * decides nothing about a Cursor turn.
 */
export function cursorAuthValue(auth: Record<string, ProviderProjection> | undefined) {
  return auth?.["cursor-sdk"] ?? auth?.cursor
}

/**
 * Point the Cursor SDK at a binding, or back at whatever the machine holds.
 *
 * The SDK has no option for its backend: it reads `CURSOR_BACKEND_URL` from the
 * process environment, and the module-scope read happens when the SDK is first
 * imported. So this is applied at config time, before the driver's lazy import,
 * rather than around each call. The key travels as an `Agent.create` argument
 * instead, which is why only the URL is written here.
 *
 * An unavailable account clears the variable rather than refusing: a config
 * apply that throws leaves the workspace unable to open at all, and the turn is
 * refused where the key is read.
 */
export function applyCursorBackendUrl(projection: ProviderProjection | undefined) {
  if (projection && !isProviderUnavailable(projection)) process.env[CURSOR_BACKEND_URL_ENV] = projection.baseUrl
  else delete process.env[CURSOR_BACKEND_URL_ENV]
}
