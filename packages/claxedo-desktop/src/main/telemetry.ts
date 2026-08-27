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
 * (packages/claxedo-server/src/platform/telemetry/errors/observability.test.ts); a
 * Claxedo-distributed build turns telemetry on explicitly at package time.
 */
import type { PostHog } from "posthog-node"

/**
 * A client, its absence, or a still-resolving construction. `posthog-node` is
 * imported lazily inside `createTelemetryClient` (its axios dependency must
 * not load in the un-opted-in path every test and self-built run takes), so
 * the entry point holds a promise; every consumer awaits it, and the
 * synchronous fatal-handler registration below is unaffected.
 */
export type TelemetryClientHandle = PostHog | undefined | Promise<PostHog | undefined>

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

/**
 * Build-time telemetry config, inlined by electron.vite.config.ts.
 *
 * A packaged app runs in a user's session, not CI's: `process.env` there holds
 * none of the deploy variables, so a release that read only the environment
 * would be permanently, silently off. These constants are how an official
 * build carries its own configuration.
 *
 * `process.env` still wins over them everywhere below — that ordering is what
 * keeps a self-builder (or a test, or a support session) able to point a build
 * at their own project, or turn it off, without rebuilding. When a variable is
 * unset at build time the define bakes `undefined` and every gate behaves
 * exactly as it did before this existed.
 */
const baked = {
  key: clean(import.meta.env.CLAXEDO_POSTHOG_KEY),
  host: clean(import.meta.env.CLAXEDO_POSTHOG_HOST),
  mode: clean(import.meta.env.CLAXEDO_TELEMETRY_MODE),
} as const

/** Only `on` permits sending, matched case-insensitively after trimming;
 *  `off`, unset, and anything unrecognized all mean off. Mirrors
 *  claxedo-server's observability/config.ts telemetryEnabled — the desktop
 *  main process reads process.env directly rather than importing the server
 *  package, so the rule is restated here rather than shared. */
function telemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  return (clean(env.CLAXEDO_TELEMETRY_MODE) ?? baked.mode)?.toLowerCase() === "on"
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
  return clean(env.CLAXEDO_POSTHOG_KEY) ?? clean(env.POSTHOG_KEY) ?? baked.key
}

export function resolveHost(env: NodeJS.ProcessEnv): string {
  return clean(env.CLAXEDO_POSTHOG_HOST) ?? baked.host ?? DEFAULT_HOST
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
export async function createTelemetryClient(env: NodeJS.ProcessEnv = process.env): Promise<PostHog | undefined> {
  const key = resolveKey(env)
  if (!key) return undefined
  // Only an opted-in, keyed build ever loads the SDK; everyone else resolves
  // to undefined without pulling posthog-node (and axios) into the process.
  const { PostHog } = await import("posthog-node")
  return new PostHog(key, { host: resolveHost(env) })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Best-effort capture: every failure mode (throwing client, unreachable
 * host, a flush that never resolves) is swallowed. Telemetry must never
 * block or compound the fatal error it exists to observe.
 */
export async function captureFatal(
  client: TelemetryClientHandle,
  baseProperties: TelemetryBaseProperties,
  error: unknown,
  flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  try {
    // A still-constructing client is awaited inside the try so a rejected
    // construction is swallowed like every other telemetry failure.
    const resolved = await client
    if (!resolved) return
    resolved.captureException(error, SYSTEM_DISTINCT_ID, baseProperties)
    await Promise.race([resolved.flush(), delay(flushTimeoutMs)])
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
export function registerFatalHandlers(client: TelemetryClientHandle, baseProperties: TelemetryBaseProperties): void {
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

/** Single call for the main entry: resolve config, start building the client
 *  (or the key-absent no-op), and wire the process-level fatal handlers. The
 *  handlers are registered SYNCHRONOUSLY with the pending client so the
 *  "before any other startup work" contract in registerFatalHandlers holds;
 *  the fatal path awaits the resolution itself. */
export function installDesktopTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<PostHog | undefined> {
  const client = createTelemetryClient(env)
  registerFatalHandlers(client, resolveBaseProperties(env))
  return client
}
