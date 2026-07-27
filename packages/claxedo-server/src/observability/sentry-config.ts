/**
 * Env → Sentry init options (D12, ops-floor decision: Sentry as the
 * observability floor). Worker-safe: imports
 * no SDK and no Node builtins — the Worker import-graph guard walks this
 * module, and worker.ts feeds the result straight into
 * `@sentry/cloudflare`'s `withSentry` options callback
 * (https://docs.sentry.io/platforms/javascript/guides/cloudflare/).
 *
 * DSN-absent contract: when `CLAXEDO_SENTRY_DSN` is missing the returned
 * options carry `enabled: false` and no `dsn`. Sentry documents both as
 * "will not send any events" — a clean no-op, safe to ship before the Sentry
 * account exists.
 * https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/
 */

export type ObservabilityUnit = "worker" | "server" | "relay"

export type ObservabilityEnv = {
  /** Sentry DSN for this unit. Absent → observability is a disabled no-op. */
  CLAXEDO_SENTRY_DSN?: string | undefined
  /** Release = git SHA, passed by the D11 deploy workflows. */
  CLAXEDO_RELEASE?: string | undefined
  /** Accepted alias for CLAXEDO_RELEASE (deploy tooling convenience). */
  GIT_SHA?: string | undefined
  /** Sentry's own conventional env var, honored last. */
  SENTRY_RELEASE?: string | undefined
  /** D9 deployment mode; absent = self-host (mirrors deployment-mode.ts). */
  CLAXEDO_DEPLOYMENT_MODE?: string | undefined
  /** Accept process.env / HostedWorkerEnv verbatim (extra keys are ignored). */
  [key: string]: string | undefined
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Release = git SHA from the D11 deploy pipeline ("this issue first appeared
 * in SHA X" is the rollback trigger). CLAXEDO_RELEASE wins; GIT_SHA and
 * SENTRY_RELEASE are accepted aliases.
 */
export function resolveRelease(env: ObservabilityEnv): string | undefined {
  return clean(env.CLAXEDO_RELEASE) ?? clean(env.GIT_SHA) ?? clean(env.SENTRY_RELEASE)
}

/**
 * Deployment-mode tag (D9). Absent env = "self-host", mirroring
 * control-plane/deployment-mode.ts's default — the tag must never throw, so
 * unlike deploymentMode() an unrecognized value is passed through verbatim
 * rather than rejected (observability reports posture, it does not enforce it).
 */
export function deploymentModeTag(env: ObservabilityEnv): string {
  return clean(env.CLAXEDO_DEPLOYMENT_MODE)?.toLowerCase() ?? "self-host"
}

/**
 * Request headers that are safe to keep on an event. Everything else is
 * DROPPED, not filtered by name — a deny-list cannot know about
 * `x-claxedo-service-token`, `x-relay-resolver-token`, or whatever the next
 * header is called, and getting it wrong ships a live credential.
 */
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
  "cf-ray",
  "x-request-id",
])

type ScrubbableRequest = {
  url?: unknown
  headers?: unknown
  cookies?: unknown
  query_string?: unknown
  data?: unknown
}

/**
 * I-5 (never report credential values): strip the request context Sentry's
 * SDKs attach on their own before the event leaves the process.
 *
 * `sendDefaultPii` defaults to false but gates NONE of this. Verified against
 * @sentry/cloudflare 10.64.0: core's requestDataIntegration copies
 * `event.request.headers` VERBATIM (so `Authorization: Bearer …` and every
 * `x-*-token` ride along), and cloudflare's httpServerIntegration captures the
 * POST/PUT/PATCH body (up to 10KB of any textual content-type) without
 * consulting `dataCollection.httpBodies`. That body is the device-login
 * `device_code`/`refresh_token` and the BYOK provider API key.
 *
 * So: allow-list the headers, and drop the body, the query string, the cookies
 * and the URL's query entirely. Method, path and stack are what actually
 * debug a 500; none of the dropped material ever did.
 *
 * Generic in the event type so it drops into both `@sentry/cloudflare`'s
 * `withSentry` options and `@sentry/node`'s `init` without importing either
 * SDK's types — this module must stay Worker-safe (the Worker import-graph
 * guard walks it) and dependency-free.
 */
export function scrubSentryEvent<Event>(event: Event): Event {
  const request = (event as { request?: ScrubbableRequest } | null | undefined)?.request
  if (!request || typeof request !== "object") return event

  if (typeof request.url === "string") {
    const query = request.url.indexOf("?")
    if (query >= 0) request.url = request.url.slice(0, query)
  }
  if (request.headers && typeof request.headers === "object") {
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(request.headers as Record<string, unknown>)) {
      if (SAFE_REQUEST_HEADERS.has(key.toLowerCase())) kept[key] = value
    }
    request.headers = kept
  }
  delete request.cookies
  delete request.query_string
  delete request.data
  return event
}

export type SentryInitOptions = {
  /** false ⇔ no DSN configured ⇔ the SDK sends nothing (documented no-op). */
  enabled: boolean
  dsn?: string
  release?: string
  /** ADR §4: tracing stays OFF — it is where Sentry gets expensive. */
  tracesSampleRate: 0
  /** Explicit, not merely defaulted: no IPs, no user info, no cookies. */
  sendDefaultPii: false
  /** I-5 credential scrub; see scrubSentryEvent. */
  beforeSend: <Event>(event: Event) => Event
  initialScope: { tags: Record<string, string> }
}

export function sentryInitOptions(env: ObservabilityEnv, unit: ObservabilityUnit): SentryInitOptions {
  const dsn = clean(env.CLAXEDO_SENTRY_DSN)
  const release = resolveRelease(env)
  return {
    enabled: !!dsn,
    ...(dsn ? { dsn } : {}),
    ...(release ? { release } : {}),
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    initialScope: {
      tags: {
        unit,
        deployment_mode: deploymentModeTag(env),
      },
    },
  }
}
