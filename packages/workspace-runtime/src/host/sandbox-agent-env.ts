import type { RuntimePlacement } from "@claxedo/harness/contract"

/**
 * The environment that tells agent CLIs they run inside Claxedo's own sandbox.
 * Every cloud sandbox image runs the runtime as root, and Claude Code exits at
 * launch when root may skip permissions unless `IS_SANDBOX=1`. A person's own
 * machine keeps that refusal.
 */
export function sandboxAgentEnv(placement: RuntimePlacement): Record<string, string> {
  return placement === "cloud" ? { IS_SANDBOX: "1" } : {}
}
