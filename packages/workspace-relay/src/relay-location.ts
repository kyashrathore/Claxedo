import { trimToUndefined } from "@claxedo/helpers/string"

// Where new relay DOs are placed when nothing better is known. APAC
// (Singapore/Mumbai) is the closest Cloudflare hint for the India/South-Asia
// user base and is deliberate, not an accident — see wrangler.toml. It is the
// deployment-wide FLOOR; `relayLocationHint()` prefers a per-workspace signal.
// Override via the CLAXEDO_RELAY_LOCATION_HINT env var.
export const DEFAULT_RELAY_LOCATION_HINT = "apac"

/**
 * The complete set of Cloudflare Durable Object location hints.
 *
 * Cloudflare rejects an unknown hint, and a rejected `get()` fails the request —
 * so an unrecognised region must fall back rather than be passed through. This
 * list is the validator for that.
 */
export const RELAY_LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const

export type RelayLocationHint = typeof RELAY_LOCATION_HINTS[number]

const relayLocationHintSet: ReadonlySet<string> = new Set<string>(RELAY_LOCATION_HINTS)

/** The membership test `RELAY_LOCATION_HINTS` exists for, as a narrowing one. */
function isRelayLocationHint(input: string): input is RelayLocationHint {
  return relayLocationHintSet.has(input)
}

/**
 * Maps a workspace home region to a Cloudflare location hint.
 *
 * The FIRST five keys are the product's canonical region vocabulary —
 * `DEFAULT_CLAXEDO_REGIONS` in `claxedo-server/src/platform/runtime/region/index.ts:1`, mirrored
 * as `KNOWN_HOME_REGIONS` in the sqlite workspace authority. Those are the
 * values a real workspace's `homeRegion` can hold, and
 * this table must stay in step with that list.
 *
 * The rest are common cloud-provider spellings, accepted so a region that
 * arrives from a provider config maps to something sensible instead of silently
 * falling back to the deployment default. Anything unrecognised returns
 * undefined and the caller falls back — never a guess, because placement is
 * PERMANENT for the workspace.
 */
const RELAY_REGION_TO_LOCATION_HINT: Record<string, RelayLocationHint> = {
  // Canonical Claxedo regions.
  "apac-south": "apac",
  "apac-east": "apac",
  "eu-west": "weur",
  "us-east": "enam",
  "us-west": "wnam",
  // Provider spellings.
  "us-central": "wnam",
  "eu-central": "weur",
  "eu-east": "eeur",
  "ap-south": "apac",
  "ap-southeast": "apac",
  "ap-northeast": "apac",
  "sa-east": "sam",
  "af-south": "afr",
  "me-central": "me",
  "oceania": "oc",
  "au-southeast": "oc",
}

/**
 * Maps a Cloudflare edge country code (`request.cf.country`) to the nearest
 * location hint.
 *
 * Deliberately coarse: this is only consulted when a workspace carries no
 * region, and its job is to beat a deployment-wide constant, not to be a
 * geo-routing table. Continent-level accuracy is enough — the cost of being
 * one region off is latency, while the cost of an invalid hint is a failed
 * request.
 */
function locationHintForCountry(country: string): RelayLocationHint | undefined {
  const code = country.toUpperCase()
  if (["US", "CA", "MX"].includes(code)) return code === "US" || code === "CA" ? "enam" : "wnam"
  if (["BR", "AR", "CL", "CO", "PE", "UY", "PY", "BO", "EC", "VE"].includes(code)) return "sam"
  if (["GB", "IE", "FR", "ES", "PT", "NL", "BE", "DE", "CH", "AT", "IT", "DK", "NO", "SE", "FI", "IS", "LU"].includes(code)) return "weur"
  if (["PL", "CZ", "SK", "HU", "RO", "BG", "GR", "UA", "RS", "HR", "SI", "EE", "LV", "LT", "TR", "RU"].includes(code)) return "eeur"
  if (["IN", "PK", "BD", "LK", "NP", "SG", "MY", "TH", "VN", "PH", "ID", "CN", "HK", "TW", "JP", "KR"].includes(code)) return "apac"
  if (["AU", "NZ", "FJ", "PG"].includes(code)) return "oc"
  if (["ZA", "NG", "KE", "GH", "ET", "TZ", "UG", "EG", "MA", "DZ", "TN"].includes(code)) {
    return ["EG", "MA", "DZ", "TN"].includes(code) ? "me" : "afr"
  }
  if (["AE", "SA", "IL", "QA", "KW", "BH", "OM", "JO", "LB", "IQ", "IR"].includes(code)) return "me"
  return undefined
}

/** A workspace region carried on the request, if the caller supplied one. */
export const RELAY_REGION_HEADER = "x-claxedo-workspace-region"

/**
 * Chooses the location hint for a workspace's Durable Object.
 *
 * This decision is PERMANENT: a DO's location is fixed at first creation and
 * never migrates, so a workspace created with the wrong hint pays the extra
 * ocean crossing on every frame for its entire life. That is why an
 * unrecognised value falls back to the configured default instead of being
 * passed through or guessed at.
 *
 * Precedence, most authoritative first:
 *  1. the workspace's own region (header or `?region=`), which is what the
 *     control plane knows and the only signal tied to the WORKSPACE rather than
 *     to whoever happens to be connecting first;
 *  2. the requesting user's Cloudflare edge country, a decent proxy when the
 *     workspace has no region yet;
 *  3. the deployment-wide configured hint (`CLAXEDO_RELAY_LOCATION_HINT`), then
 *     `DEFAULT_RELAY_LOCATION_HINT`.
 */
export function relayLocationHint(input: {
  configured?: string
  region?: string
  country?: string
}) {
  const configured = trimToUndefined(input.configured) ?? DEFAULT_RELAY_LOCATION_HINT
  const region = trimToUndefined(input.region)
  if (region) {
    // A caller may pass a literal CF hint (e.g. "weur") or a workspace region
    // name (e.g. "eu-west"); accept either.
    const lowered = region.toLowerCase()
    const direct = isRelayLocationHint(lowered) ? lowered : undefined
    const mapped = direct ?? RELAY_REGION_TO_LOCATION_HINT[lowered]
    if (mapped) return mapped
  }
  const country = trimToUndefined(input.country)
  if (country) {
    const mapped = locationHintForCountry(country)
    if (mapped) return mapped
  }
  return configured
}

/** The workspace region a request declares, if any. */
export function relayRequestRegion(request: Request) {
  const url = new URL(request.url)
  return trimToUndefined(request.headers.get(RELAY_REGION_HEADER))
    ?? trimToUndefined(url.searchParams.get("region"))
    ?? trimToUndefined(url.searchParams.get("homeRegion"))
}

/** The Cloudflare edge country for the request, when running on Cloudflare. */
export function relayRequestCountry(request: Request) {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf
  return typeof cf?.country === "string" ? cf.country : undefined
}
