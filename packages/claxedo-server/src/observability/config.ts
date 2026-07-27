/**
 * Env → observability init options. PostHog carries product analytics AND
 * error tracking for every runtime, so one key resolves both planes and there
 * is no second class of observability secret to provision.
 *
 * Worker-safe by construction: imports no SDK and no Node builtins. The Worker
 * import-graph guard walks this module, and `posthog-node` is on the Worker's
 * forbidden-import list — the Worker feeds these options into a fetch-based
 * sink, the Node server feeds them into the shared `posthog-node` client.
 *
 * Key-absent contract: with no PostHog key the returned options carry
 * `enabled: false` and no key. Every caller treats that as "never initialize,
 * register no sink" — the self-host promise (no keys configured ⇒ nothing is
 * sent, no network calls) is a property of this branch.
 */

export type ObservabilityUnit = "worker" | "server" | "relay"

export type ObservabilityEnv = {
  /** Project key for this unit. Absent → observability is a disabled no-op. */
  CLAXEDO_POSTHOG_KEY?: string | undefined
  /** Unprefixed alias, honored second (predates the CLAXEDO_ prefix). */
  POSTHOG_KEY?: string | undefined
  /** Ingest host override (self-hosted PostHog, or the EU cloud region). */
  CLAXEDO_POSTHOG_HOST?: string | undefined
  /** Unprefixed alias, honored second. */
  POSTHOG_HOST?: string | undefined
  /** Release = git SHA, passed by the D11 deploy workflows. */
  CLAXEDO_RELEASE?: string | undefined
  /** Accepted alias for CLAXEDO_RELEASE (deploy tooling convenience). */
  GIT_SHA?: string | undefined
  /** D9 deployment mode; absent = self-host (mirrors deployment-mode.ts). */
  CLAXEDO_DEPLOYMENT_MODE?: string | undefined
  /** Accept process.env / HostedWorkerEnv verbatim (extra keys are ignored). */
  [key: string]: string | undefined
}

/** Canonical PostHog Cloud ingest host. `app.posthog.com` is the legacy alias. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Release = git SHA from the D11 deploy pipeline ("this issue first appeared
 * in SHA X" is the rollback trigger). CLAXEDO_RELEASE wins; GIT_SHA is the one
 * accepted alias — vendor-named release variables are deliberately not read.
 */
export function resolveRelease(env: ObservabilityEnv): string | undefined {
  return clean(env.CLAXEDO_RELEASE) ?? clean(env.GIT_SHA)
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
 * The single key both telemetry planes read. The unprefixed alias keeps
 * existing self-host deployments (which set POSTHOG_KEY/POSTHOG_HOST as a
 * pair) working unchanged.
 */
export function resolveTelemetryKey(env: ObservabilityEnv): string | undefined {
  return clean(env.CLAXEDO_POSTHOG_KEY) ?? clean(env.POSTHOG_KEY)
}

/** Trailing slashes are stripped: sinks append absolute paths like `/capture/`. */
export function resolveTelemetryHost(env: ObservabilityEnv): string {
  const host = clean(env.CLAXEDO_POSTHOG_HOST) ?? clean(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST
  return host.replace(/\/+$/, "")
}

export type ObservabilityOptions = {
  /** false ⇔ no key configured ⇔ never initialize, register no sink. */
  enabled: boolean
  key?: string
  host: string
  release?: string
  /** Base properties stamped on every event this unit reports. */
  tags: Record<string, string>
}

export function observabilityOptions(env: ObservabilityEnv, unit: ObservabilityUnit): ObservabilityOptions {
  const key = resolveTelemetryKey(env)
  const release = resolveRelease(env)
  return {
    enabled: !!key,
    ...(key ? { key } : {}),
    host: resolveTelemetryHost(env),
    ...(release ? { release } : {}),
    tags: {
      unit,
      deployment_mode: deploymentModeTag(env),
      ...(release ? { release } : {}),
    },
  }
}
