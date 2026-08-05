/**
 * The PostHog provider for the public site — the half that `analytics.ts` has
 * always been missing. That module builds and validates conversion events and
 * hands them to `window.claxedoAnalytics.track`; until this file existed
 * nothing ever assigned that global, so every event was dropped on unload.
 *
 * Three properties of this integration are deliberate and load-bearing:
 *
 * 1. **One opt-in, not two.** The app/server/relay runtimes require
 *    `CLAXEDO_TELEMETRY_MODE=on` *and* a key, because a self-hoster running
 *    those binaries must not phone home. Nobody self-hosts claxedo.com, so the
 *    second switch would protect no one here while adding a silent-zero-data
 *    failure mode (deploy forgets the switch; site looks fine; no data arrives
 *    and nothing says so). Key presence is the whole gate.
 *
 * 2. **No cookies.** `sessionStorage` rather than the default
 *    `localStorage+cookie`: no consent banner is required, and the site keeps
 *    the zero-cookie posture it shipped with. `memory` would have been the
 *    obvious "cookieless" pick and is the wrong one — Astro is an MPA, so every
 *    navigation is a fresh page load and memory persistence would mint a new
 *    distinct id per page, turning a two-page funnel into two unrelated people.
 *    The accepted cost is that a visitor returning next week counts as new.
 *
 * 3. **URLs never leave at full fidelity.** PostHog's own URL properties are
 *    rewritten to the same coarse route buckets `analytics.ts` already enforces
 *    on conversion events, so a private-looking docs path can never be
 *    exfiltrated through `$current_url` after being carefully kept out of the
 *    event payload. See `coarsenProperties` below.
 */
import { conversionRoute, type ConversionEvent } from "./analytics"

/** Astro exposes only `PUBLIC_`-prefixed variables to client code (the app's
 *  `VITE_` prefix is a Vite-app convention and does not apply here). */
const key = import.meta.env.PUBLIC_POSTHOG_KEY
const host = import.meta.env.PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"

/**
 * Every PostHog-set property that can carry a URL. Each is rewritten to its
 * coarse route bucket, or dropped when the URL is off-site and therefore not
 * ours to bucket — except the referrer pair, where an external origin is the
 * whole point of the property and is kept as-is.
 */
const URL_PROPERTIES = ["$current_url", "$initial_current_url", "$pathname", "$initial_pathname"] as const

/** Referrers: an external one is kept (that's the acquisition signal), an
 *  internal one is coarsened so an on-site detail path can't ride in. */
const REFERRER_PROPERTIES = ["$referrer", "$initial_referrer"] as const

const SITE_ORIGIN = "https://claxedo.com"

/**
 * Reduce a URL or path to the coarse route bucket, reusing the exact
 * classifier the conversion contract already uses. Anything that does not
 * classify — an unknown page, a malformed value — collapses to `"/other"`
 * rather than passing through: an unrecognized path is precisely the case
 * where a literal value would be most surprising to leak.
 */
export function coarsenUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined
  let pathname: string
  try {
    // Accepts both absolute URLs ($current_url) and bare paths ($pathname).
    pathname = new URL(value, SITE_ORIGIN).pathname
  } catch {
    return "/other"
  }
  return conversionRoute(pathname) ?? "/other"
}

/** True when the value is a URL pointing somewhere other than claxedo.com. */
function isExternal(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return false
  try {
    return new URL(value).origin !== SITE_ORIGIN
  } catch {
    // Not an absolute URL (bare path, or PostHog's "$direct" sentinel) —
    // "$direct" is meaningful and must survive, a bare path is internal.
    return value === "$direct"
  }
}

/**
 * The `sanitize_properties` hook, extracted as a pure function so the privacy
 * property is testable without a browser or a live client. Runs on EVERY
 * captured event, including PostHog's own `$pageview` and `$autocapture`-class
 * events, which is why it is the right layer for this rather than the capture
 * call sites.
 */
export function coarsenProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const next = { ...properties }
  for (const property of URL_PROPERTIES) {
    if (!(property in next)) continue
    next[property] = coarsenUrl(next[property])
  }
  for (const property of REFERRER_PROPERTIES) {
    if (!(property in next)) continue
    if (isExternal(next[property])) continue
    next[property] = coarsenUrl(next[property])
  }
  return next
}

/**
 * Init options. Exported for the contract test: several of these are guards
 * against a future posthog-js default flipping under us (autocapture and
 * session recording are both opt-out, not opt-in, in the SDK's defaults), and
 * a test that asserts them is what makes that flip fail loudly here rather
 * than silently start recording visitors.
 */
export const initOptions = {
  api_host: host,
  // No cookies, but stable within a visit. See the header comment.
  persistence: "sessionStorage",
  // The bounded-event contract in analytics.ts is the entire instrumentation
  // surface; autocapture would collect every click and input on the page and
  // can lift text out of element labels.
  autocapture: false,
  disable_session_recording: true,
  // Captured manually below so the coarsened route rides along as a property.
  capture_pageview: false,
  // The site never calls identify(), so this keeps PostHog from creating a
  // person profile per anonymous visitor.
  person_profiles: "identified_only",
  sanitize_properties: coarsenProperties,
} as const

/**
 * Load the SDK and fill the `claxedoAnalytics` seam. Dynamically imported so
 * posthog-js stays out of the initial bundle, mirroring the app's own
 * `loadPostHog` (packages/claxedo-app/src/platform/telemetry/analytics.ts).
 *
 * A keyless build returns before the import, so no SDK is fetched, no global
 * is assigned, and `analytics.ts`'s optional call stays a no-op — the same
 * shape the site had before this file existed.
 */
export async function initPostHog(): Promise<void> {
  if (!key) return
  const { default: posthog } = await import("posthog-js")
  posthog.init(key, initOptions)
  window.claxedoAnalytics = {
    track: (event: ConversionEvent) => {
      posthog.capture(event.name, event)
    },
  }
  posthog.capture("$pageview", { route: conversionRoute(window.location.pathname) ?? "/other" })
}

// Dev builds never send: `import.meta.env.DEV` is inlined by Vite, so this
// whole call drops out of a production bundle's dead-code elimination only
// when false — i.e. the guard costs nothing in the shipped build.
if (!import.meta.env.DEV) void initPostHog()
