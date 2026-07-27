/**
 * Main-process fatal-error capture (W2e). This is the ONLY telemetry surface
 * in the main process — the renderer loads claxedo-app, which already owns
 * its own posthog-js init/capture path; duplicating that here would double
 * every renderer-side event.
 *
 * Sending requires two independent opt-ins — `CLAXEDO_TELEMETRY_MODE=on` AND
 * a PostHog key — so a self-built, key-less, or simply un-opted-in desktop
 * run makes zero client construction and zero network calls. This matches the
 * contract the other runtimes' observability tests enforce
 * (packages/claxedo-server/src/observability/observability.test.ts); a
 * Claxedo-distributed build turns telemetry on explicitly at package time.
 */
import { PostHog } from "posthog-node"

export type TelemetryBaseProperties = {
  unit: "desktop-main"
  deployment_mode: "desktop-local"
  release?: string
}

const DEFAULT_HOST = "https://us.i.posthog.com"

/** Bounds the fatal-path flush so an unreachable PostHog host can never hold
 *  up the process exit the flush itself exists to record. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000

/** No signed-in user is resolvable from a main-process crash; this mirrors
 *  the ops-plane "system" distinct id rather than inventing a per-install id. */
const SYSTEM_DISTINCT_ID = "system"

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Only `on` permits sending, matched case-insensitively after trimming;
 *  `off`, unset, and anything unrecognized all mean off. Mirrors
 *  claxedo-server's observability/config.ts telemetryEnabled — the desktop
 *  main process reads process.env directly rather than importing the server
 *  package, so the rule is restated here rather than shared. */
function telemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  return clean(env.CLAXEDO_TELEMETRY_MODE)?.toLowerCase() === "on"
}

/** CLAXEDO_POSTHOG_KEY first; POSTHOG_KEY is the unprefixed fallback shared
 *  with the server/relay sinks so one project key works across runtimes.
 *  The mode is checked BEFORE either name, so a build that has not opted in
 *  resolves to `undefined` and every downstream branch treats it exactly like
 *  an unconfigured one.
 *  Exported so the gate is directly testable — the value otherwise only
 *  surfaces as an opaque SDK-internal field on the client. */
export function resolveKey(env: NodeJS.ProcessEnv): string | undefined {
  if (!telemetryEnabled(env)) return undefined
  return clean(env.CLAXEDO_POSTHOG_KEY) ?? clean(env.POSTHOG_KEY)
}

export function resolveHost(env: NodeJS.ProcessEnv): string {
  return clean(env.CLAXEDO_POSTHOG_HOST) ?? DEFAULT_HOST
}

/** CLAXEDO_RELEASE wins; GIT_SHA is the deploy-tooling alias the other
 *  runtimes' observability config already accepts. */
function resolveRelease(env: NodeJS.ProcessEnv): string | undefined {
  return clean(env.CLAXEDO_RELEASE) ?? clean(env.GIT_SHA)
}

export function resolveBaseProperties(env: NodeJS.ProcessEnv = process.env): TelemetryBaseProperties {
  const release = resolveRelease(env)
  return {
    unit: "desktop-main",
    deployment_mode: "desktop-local",
    ...(release ? { release } : {}),
  }
}

/**
 * Builds the fatal-capture client, or nothing at all unless the build both
 * opted in and carries a key (resolveKey folds both into one answer). No
 * `personalApiKey` is ever passed, so the SDK never starts a feature-flag
 * poller; `enableExceptionAutocapture` is deliberately left unset so this
 * module's own `process.on` wiring is the single source of fatal handling
 * (the SDK's built-in autocapture would install a second, competing set of
 * listeners with different exit semantics).
 */
export function createTelemetryClient(env: NodeJS.ProcessEnv = process.env): PostHog | undefined {
  const key = resolveKey(env)
  if (!key) return undefined
  return new PostHog(key, { host: resolveHost(env) })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Best-effort capture: every failure mode (throwing client, unreachable
 * host, a flush that never resolves) is swallowed. Telemetry must never
 * block or compound the fatal error it exists to observe.
 */
export async function captureFatal(
  client: PostHog | undefined,
  baseProperties: TelemetryBaseProperties,
  error: unknown,
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!client) return
  try {
    client.captureException(error, SYSTEM_DISTINCT_ID, baseProperties)
    await Promise.race([client.flush(), delay(flushTimeoutMs)])
  } catch {
    // Best-effort only — see the doc comment above.
  }
}

/**
 * Registers the main process's last-resort handlers. Call this before any
 * other startup work: attaching an `uncaughtException` listener disables
 * Electron/Node's default fatal behavior (crash dialog + exit), so from this
 * point on THIS handler is what keeps a thrown error from leaving the app
 * hanging instead of failing fast. A key-less client (`undefined`) still
 * gets the same log-then-exit handling; `captureFatal` just no-ops on it.
 */
export function registerFatalHandlers(client: PostHog | undefined, baseProperties: TelemetryBaseProperties): void {
  process.on("uncaughtException", (error) => {
    console.error("[claxedo-desktop] fatal: uncaught exception", error)
    void captureFatal(client, baseProperties, error).finally(() => {
      process.exit(1)
    })
  })

  process.on("unhandledRejection", (reason) => {
    // Capture only, no exit: an unhandled rejection alone stays a
    // recoverable-app-state condition here, unlike a synchronous throw.
    console.error("[claxedo-desktop] unhandled rejection", reason)
    void captureFatal(client, baseProperties, reason)
  })
}

/** Single call for the main entry: resolve config, build the client (or the
 *  key-absent no-op), and wire the process-level fatal handlers. */
export function installDesktopTelemetry(env: NodeJS.ProcessEnv = process.env): PostHog | undefined {
  const client = createTelemetryClient(env)
  registerFatalHandlers(client, resolveBaseProperties(env))
  return client
}
