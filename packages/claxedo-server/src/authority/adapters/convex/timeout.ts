import { timeoutMsFromEnv } from "../../../platform/runtime/timeout"

export {
  ControlPlaneRequestTimeoutError,
  withTimeout,
} from "../../../platform/runtime/timeout"

export type ControlPlaneTimeoutKind = "read" | "mutation"

/**
 * Wait bounds for Convex queries and mutations. The env names are spelled
 * plainly here because this file IS the Convex adapter — the architecture
 * guard that bans adapter tokens elsewhere permits them at exactly this layer.
 *
 * Writes get the longer bound: a mutation that exceeds it may still commit
 * (`withTimeout` bounds the caller, not the fetch), so timing one out early
 * buys a retry decision the caller then has to make idempotent.
 */
export function controlPlaneTimeoutMs(
  kind: ControlPlaneTimeoutKind,
  env: Record<string, string | undefined> = process.env,
) {
  return kind === "read"
    ? timeoutMsFromEnv("CLAXEDO_CONVEX_READ_TIMEOUT_MS", 5_000, env)
    : timeoutMsFromEnv("CLAXEDO_CONVEX_MUTATION_TIMEOUT_MS", 10_000, env)
}
