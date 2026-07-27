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

export type SentryInitOptions = {
  /** false ⇔ no DSN configured ⇔ the SDK sends nothing (documented no-op). */
  enabled: boolean
  dsn?: string
  release?: string
  /** ADR §4: tracing stays OFF — it is where Sentry gets expensive. */
  tracesSampleRate: 0
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
    initialScope: {
      tags: {
        unit,
        deployment_mode: deploymentModeTag(env),
      },
    },
  }
}
