import { cleanString as clean } from "../../runtime/lib/strings"
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
 * Sending requires TWO independent opt-ins: `CLAXEDO_TELEMETRY_MODE=on` AND a
 * PostHog key. Anything else — mode off, mode unset, key absent — yields
 * options carrying `enabled: false` and no key, and every caller treats that as
 * "never initialize, register no sink". Both halves of the deployer-facing
 * promise (a deployment sends only when it says `on`; no keys configured ⇒
 * nothing is sent, no network calls) are properties of that one branch.
 *
 * `resolveTelemetryKey` is the single place both opt-ins are applied, which is
 * what makes them total: posthog.ts, observability/node.ts,
 * authority/worker-telemetry.ts and worker.ts's sink registration all
 * resolve their key through this module and inherit the gate.
 */

export type ObservabilityUnit = "worker" | "server" | "relay"

export type ObservabilityEnv = {
  /** Project key for this unit. Absent → observability is a disabled no-op,
   *  and a key alone never enables it; see telemetryEnabled below. */
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
  /** The named switch. Only `on` permits sending; see telemetryEnabled below. */
  CLAXEDO_TELEMETRY_MODE?: string | undefined
  /** Accept process.env / HostedWorkerEnv verbatim (extra keys are ignored). */
  [key: string]: string | undefined
}

/** Canonical PostHog Cloud ingest host. `app.posthog.com` is the legacy alias. */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"


/**
 * Release = git SHA from the D11 deploy pipeline ("this issue first appeared
 * in SHA X" is the rollback trigger). CLAXEDO_RELEASE wins; GIT_SHA is the one
 * accepted alias — vendor-named release variables are deliberately not read.
 */
export function resolveRelease(env: ObservabilityEnv): string | undefined {
  return clean(env.CLAXEDO_RELEASE) ?? clean(env.GIT_SHA)
}

/**
 * Deployment trust tag. Absent env = "local", mirroring
 * authority/deployment-mode.ts's default — the tag must never throw, so
 * unlike deploymentMode() an unrecognized value is passed through verbatim
 * rather than rejected (observability reports posture, it does not enforce it).
 *
 * That pass-through is precisely why this function had to be renamed in the
 * SAME commit as the enum: left behind, it would have kept emitting the retired
 * "self-host" tag forever — corrupting telemetry silently instead of failing
 * loudly like the boot path does.
 */
export function deploymentModeTag(env: ObservabilityEnv): string {
  return clean(env.CLAXEDO_DEPLOYMENT_MODE)?.toLowerCase() ?? "local"
}

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
  return clean(env.CLAXEDO_TELEMETRY_MODE)?.toLowerCase() === "on"
}

/**
 * The single key both telemetry planes read, and the single place both opt-ins
 * are enforced. `CLAXEDO_POSTHOG_KEY` wins; the unprefixed `POSTHOG_KEY` is
 * accepted as an alias so one project key can be shared across runtimes.
 *
 * The switch is checked BEFORE either key name, so any mode other than `on`
 * resolves to the same `undefined` an unconfigured deployment produces and
 * every downstream sink takes its existing key-absent branch — no client, no
 * network. Ordering is the contract, not a detail: reading the key first would
 * let a configured key outrank the deployment's own stated posture.
 */
export function resolveTelemetryKey(env: ObservabilityEnv): string | undefined {
  if (!telemetryEnabled(env)) return undefined
  return clean(env.CLAXEDO_POSTHOG_KEY) ?? clean(env.POSTHOG_KEY)
}

/** Trailing slashes are stripped: sinks append absolute paths like `/capture/`. */
export function resolveTelemetryHost(env: ObservabilityEnv): string {
  const host = clean(env.CLAXEDO_POSTHOG_HOST) ?? clean(env.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST
  return host.replace(/\/+$/, "")
}

export type ObservabilityOptions = {
  /** true ⇔ mode is `on` AND a key is configured. false ⇒ never initialize,
   *  register no sink. */
  enabled: boolean
  key?: string
  host: string
  release?: string
  /** Base properties stamped on every event this unit reports. */
  tags: Record<string, string>
}

/**
 * Execution runtime for this unit. DERIVED from the unit, never read from the
 * environment — the Worker is the only workerd unit, everything else is Node.
 * Adds no operator surface.
 *
 * Paired with `deployment_mode` (trust) this makes `node-hosted` and
 * `workerd-hosted` distinguishable in telemetry. "hosted" alone says nothing
 * about where code runs: hosted-app.ts serves both.
 */
export function deploymentRuntimeTag(unit: ObservabilityUnit): "node" | "workerd" {
  return unit === "worker" ? "workerd" : "node"
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
      deployment_runtime: deploymentRuntimeTag(unit),
      ...(release ? { release } : {}),
    },
  }
}
