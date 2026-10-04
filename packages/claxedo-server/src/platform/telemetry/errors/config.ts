import { trimToUndefined } from "@claxedo/helpers/string"
/**
 * The PostHog key and ingest host the Worker's telemetry sink
 * (`platform/auth/worker-telemetry.ts`) reads. Worker-safe by construction:
 * imports no SDK and no Node builtins.
 *
 * Sending requires TWO independent opt-ins: `CLAXEDO_TELEMETRY_MODE=on` AND a
 * PostHog key. Anything else — mode off, mode unset, key absent — resolves no
 * key, and the sink treats that as "register nothing". Both halves of the
 * deployer-facing promise (a deployment sends only when it says `on`; no keys
 * configured ⇒ nothing is sent, no network calls) are properties of
 * `resolveTelemetryKey`.
 */

export type ObservabilityEnv = {
  /** Project key. Absent → telemetry is a disabled no-op,
   *  and a key alone never enables it; see telemetryEnabled below. */
  CLAXEDO_POSTHOG_KEY?: string | undefined
  /** Unprefixed alias, honored second (predates the CLAXEDO_ prefix). */
  POSTHOG_KEY?: string | undefined
  /** Ingest host override (self-hosted PostHog, or the EU cloud region). */
  CLAXEDO_POSTHOG_HOST?: string | undefined
  /** Unprefixed alias, honored second. */
  POSTHOG_HOST?: string | undefined
  /** The named switch. Only `on` permits sending; see telemetryEnabled below. */
  CLAXEDO_TELEMETRY_MODE?: string | undefined
  /** Accept HostedWorkerEnv verbatim (extra keys are ignored). */
  [key: string]: string | undefined
}

/** Canonical PostHog Cloud ingest host. `app.posthog.com` is the legacy alias. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"

/**
 * `CLAXEDO_TELEMETRY_MODE=on` — the named switch, matched case-insensitively
 * after trimming. `on` is the sole value that permits sending; `off`, unset,
 * and any unrecognized value all mean off.
 *
 * Off is the default so that telemetry is something a deployment opts into by
 * saying so, rather than something it acquires by side effect. A key alone is
 * a configuration detail that can arrive through a shared secret store or a
 * copied env file; `on` is a deliberate statement, and requiring both keeps
 * the deployer-facing promise ("a build running in `on` mode is the only build
 * that sends anything") literally true.
 */
export function telemetryEnabled(env: ObservabilityEnv): boolean {
  return trimToUndefined(env.CLAXEDO_TELEMETRY_MODE)?.toLowerCase() === "on"
}

/**
 * The single place both opt-ins are enforced. `CLAXEDO_POSTHOG_KEY` wins; the
 * unprefixed `POSTHOG_KEY` is accepted as an alias so one project key can be
 * shared across runtimes.
 *
 * The switch is checked BEFORE either key name, so any mode other than `on`
 * resolves to the same `undefined` an unconfigured deployment produces and the
 * sink takes its key-absent branch — no network. Ordering is the contract, not
 * a detail: reading the key first would let a configured key outrank the
 * deployment's own stated posture.
 */
export function resolveTelemetryKey(env: ObservabilityEnv): string | undefined {
  if (!telemetryEnabled(env)) return undefined
  return trimToUndefined(env.CLAXEDO_POSTHOG_KEY) ?? trimToUndefined(env.POSTHOG_KEY)
}

/** Trailing slashes are stripped: sinks append absolute paths like `/capture/`. */
export function resolveTelemetryHost(env: ObservabilityEnv): string {
  const host = trimToUndefined(env.CLAXEDO_POSTHOG_HOST) ?? trimToUndefined(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST
  return host.replace(/\/+$/, "")
}
