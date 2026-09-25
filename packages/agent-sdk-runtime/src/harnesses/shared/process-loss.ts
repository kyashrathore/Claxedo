import type { AgentHarnessAdapterHealth } from "../../adapter-contract"

/**
 * A driver's record of the process it lost under a turn, kept until a
 * replacement starts. Every change is reported, because the host publishes
 * health only when told it may have moved.
 */
export function createProcessLoss(onChange: () => void) {
  let lost: string | undefined
  return {
    record(message: string) {
      if (lost === message) return
      lost = message
      onChange()
    },
    recovered() {
      if (lost === undefined) return
      lost = undefined
      onChange()
    },
    health(): AgentHarnessAdapterHealth | undefined {
      return lost === undefined ? undefined : { status: "degraded", reason: "harness_process_lost", message: lost }
    },
  }
}

export type ProcessLoss = ReturnType<typeof createProcessLoss>
