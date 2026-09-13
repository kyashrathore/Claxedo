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
  if (projection && !isProviderUnavailable(projection)) {
    process.env[CURSOR_BACKEND_URL_ENV] = projection.baseUrl
    appliedBindingUrls.add(projection.baseUrl)
  } else delete process.env[CURSOR_BACKEND_URL_ENV]
}

/**
 * Whether a frozen backend URL is one this module wrote for a binding.
 *
 * An operator who exports `CURSOR_BACKEND_URL` for a proxy of their own has a
 * value here too, and refusing their unbound turns because of it would break a
 * setup the broker has nothing to do with.
 */
export function isCursorBindingBackendUrl(value: string | undefined): boolean {
  return value !== undefined && appliedBindingUrls.has(value)
}

const appliedBindingUrls = new Set<string>()

/**
 * The backend URL the installed SDK froze.
 *
 * `@cursor/sdk@1.0.24` reads `CURSOR_BACKEND_URL` at module scope
 * (`const Mh = process.env.CURSOR_BACKEND_URL || "https://api2.cursor.sh"`) and
 * exposes no per-agent option, so the value in force at the first import is the
 * one every local agent in this process uses. Setting the variable afterwards
 * changes nothing, and an agent created then would send the placeholder to
 * Cursor's own host — or the machine's key to the broker.
 */
export function freezeCursorBackendUrl() {
  loadedBackendUrl ??= { value: process.env[CURSOR_BACKEND_URL_ENV] }
}

/** What the SDK froze, or nothing when this process has never imported it. */
export function frozenCursorBackendUrl(): { value: string | undefined } | undefined {
  return loadedBackendUrl
}

/** Test seam: the freeze is process state, and a test needs to start over. */
export function forgetCursorBackendUrl() {
  loadedBackendUrl = undefined
  appliedBindingUrls.clear()
}

let loadedBackendUrl: { value: string | undefined } | undefined

export class CursorBackendUrlFrozenError extends Error {
  constructor(readonly frozen: string | undefined, readonly required: string | undefined) {
    super(
      "the cursor credential binding cannot be used: the Cursor SDK froze "
      + `${frozen ?? "its default backend"} at import, `
      + (required
        ? `before this binding named ${required}`
        : "and this workspace now selects no bound account for it"),
    )
    this.name = "CursorBackendUrlFrozenError"
  }
}
