/**
 * The single source of truth for what an Atlassian `site_url` may be.
 *
 * Two places enforce this rule and they must not drift:
 *   1. connect time — `normalizeSiteUrl` in `./atlassian.ts`, which decides
 *      where `verify()` sends `Basic base64(email:token)` and what gets stored.
 *   2. request time — `requireBaseUrl` in
 *      `packages/workgraph/src/connectors/jira/source-view.ts`, which decides
 *      where a STORED value may send those same credentials.
 *
 * The rule lives in two implementations because workgraph does not depend on
 * this package at runtime. That duplication is only safe if a divergence fails
 * a test, so both suites iterate this array. It is not hypothetical: when these
 * vectors were first run against both implementations they disagreed on three
 * inputs — embedded credentials, a query string, and a fragment — which connect
 * time accepted and request time refused.
 *
 * `expected` is the canonical origin an accepted input normalizes to, or
 * `undefined` for an input that must be refused. Both implementations return
 * a bare origin, so a stored path can never corrupt an appended REST path.
 */
export type AtlassianSiteUrlVector = Readonly<{
  input: string
  expected: string | undefined
  /** Why this case exists, so a future editor does not "simplify" it away. */
  reason: string
}>

export const ATLASSIAN_SITE_URL_VECTORS: readonly AtlassianSiteUrlVector[] = [
  // --- Accepted, and what they canonicalize to ---
  {
    input: "https://acme.atlassian.net",
    expected: "https://acme.atlassian.net",
    reason: "the canonical shape, already normalized",
  },
  {
    input: "https://acme.atlassian.net/",
    expected: "https://acme.atlassian.net",
    reason: "a bare trailing slash is not a meaningful path",
  },
  {
    input: "  https://acme.atlassian.net/wiki/home/  ",
    expected: "https://acme.atlassian.net",
    reason: "surrounding whitespace and a pasted deep link both reduce to the origin",
  },
  {
    input: "https://ACME.atlassian.net",
    expected: "https://acme.atlassian.net",
    reason: "hostnames are case-insensitive; URL parsing lowercases them",
  },
  {
    input: "https://my-team2.atlassian.net",
    expected: "https://my-team2.atlassian.net",
    reason: "digits and inner hyphens are legal in a site label",
  },

  // --- Refused: wrong scheme or port ---
  {
    input: "http://acme.atlassian.net",
    expected: undefined,
    reason: "plaintext would put Basic credentials on the wire in the clear",
  },
  {
    input: "https://acme.atlassian.net:8443",
    expected: undefined,
    reason: "Atlassian Cloud is always on the default port",
  },

  // --- Refused: not actually an Atlassian Cloud site ---
  {
    input: "https://evil.example",
    expected: undefined,
    reason: "an unrelated host would receive the API token",
  },
  {
    input: "https://atlassian.net",
    expected: undefined,
    reason: "the bare apex is not a site",
  },
  {
    input: "https://sub.acme.atlassian.net",
    expected: undefined,
    reason: "exactly one label before the suffix keeps the shape predictable",
  },
  {
    input: "https://evil-atlassian.net",
    expected: undefined,
    reason: "suffix lookalike with no dot separator",
  },
  {
    input: "https://acme.atlassian.net.evil.com",
    expected: undefined,
    reason: "the real suffix appears mid-host; a naive contains-check would pass this",
  },
  {
    input: "https://.atlassian.net",
    expected: undefined,
    reason: "empty site label",
  },
  {
    input: "https://-acme.atlassian.net",
    expected: undefined,
    reason: "a DNS label may not begin with a hyphen",
  },

  // --- Refused: parts that `origin` would silently discard ---
  // These are the three that actually diverged. `url.origin` drops them, so
  // accepting the input would connect somewhere other than what was typed.
  {
    input: "https://attacker:pw@acme.atlassian.net",
    expected: undefined,
    reason: "embedded credentials are the classic way to disguise a hostile URL",
  },
  {
    input: "https://acme.atlassian.net?next=https://evil.example",
    expected: undefined,
    reason: "a query the origin would drop signals the operator meant something else",
  },
  {
    input: "https://acme.atlassian.net#/wiki",
    expected: undefined,
    reason: "same as a query: silently discarded, so refuse instead",
  },

  // --- Refused: not a URL at all ---
  { input: "not a url", expected: undefined, reason: "unparseable" },
  { input: "", expected: undefined, reason: "empty input" },
  {
    input: "acme.atlassian.net",
    expected: undefined,
    reason: "no scheme: must be explicit rather than assumed https",
  },
  {
    input: "javascript:alert(1)//acme.atlassian.net",
    expected: undefined,
    reason: "a non-http scheme must never reach a fetch",
  },
] as const
