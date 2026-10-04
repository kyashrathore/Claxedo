export const sandboxStartPhases = [
  "lease_decision",
  "provider_ready",
  "image_ready",
  "repository_checkout",
  "start_script",
  "runtime_ready",
  "first_session_ready",
] as const

export type SandboxStartPhase = (typeof sandboxStartPhases)[number]

/** The phases a workspace runtime measures inside its own sandbox and reports once per boot. */
export const sandboxRuntimeStartPhases = ["repository_checkout", "start_script"] as const satisfies readonly SandboxStartPhase[]

export type SandboxRuntimeStartPhase = (typeof sandboxRuntimeStartPhases)[number]

export const sandboxPrebuildPhases = [
  "builder_ready",
  "fetch",
  "setup_script",
  "quiesce_and_scrub",
  "snapshot",
  "registry_write",
] as const

export type SandboxPrebuildPhase = (typeof sandboxPrebuildPhases)[number]

export type SandboxPhaseTiming<Phase extends string> = { phase: Phase; durationMs: number }

export function isSandboxRuntimeStartPhase(input: unknown): input is SandboxRuntimeStartPhase {
  return sandboxRuntimeStartPhases.some((phase) => phase === input)
}

/**
 * Times the phases of one process's own sequential work: a runtime's boot or a
 * prebuild. A phase that throws is still timed, so a failed run reports how far
 * it got.
 */
export function createSandboxPhaseTimer<Phase extends string>(now: () => number = Date.now) {
  const timings: SandboxPhaseTiming<Phase>[] = []
  return {
    async measure<T>(phase: Phase, run: () => Promise<T>): Promise<T> {
      const startedAt = now()
      try {
        return await run()
      } finally {
        timings.push({ phase, durationMs: Math.max(0, now() - startedAt) })
      }
    },
    timings: (): SandboxPhaseTiming<Phase>[] => timings.slice(),
  }
}
