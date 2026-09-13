import { randomUUID } from "node:crypto"
import type { HarnessReference, TasksCapabilitiesPort, TasksClockPort, TasksHostCapabilities, TasksIdsPort } from "@claxedo/tasks"

export function systemTasksClock(): TasksClockPort {
  return { now: () => Date.now() }
}

export function randomTasksIds(): TasksIdsPort {
  return {
    presetId: () => `tpr_${randomUUID()}`,
    taskId: () => `tsk_${randomUUID()}`,
  }
}

/**
 * The effort vocabulary a saved preset may name. It keeps a preset from
 * storing a word the runtime's `variant` field could never mean, and nothing
 * further: preview validates model availability and not effort, so an effort
 * this list admits and the chosen model does not honour is refused by the
 * runtime when the session is created.
 */
const TASKS_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

export type TasksCapabilitiesInput = {
  placements: TasksHostCapabilities["placements"]
  cloudSelectedCapabilities: boolean
}

/**
 * Structural validation only, which is why an unknown harness id is not
 * refused here: which harnesses a concrete target actually offers is the
 * session bridge's answer at preview and start (`harness_unavailable`), and a
 * save-time catalog would refuse a preset for a machine the user has not
 * selected yet.
 */
export function createTasksCapabilities(input: TasksCapabilitiesInput): TasksCapabilitiesPort {
  return {
    async describe() {
      return {
        placements: input.placements,
        cloudSelectedCapabilities: input.cloudSelectedCapabilities,
      }
    },
    async harness(reference: HarnessReference) {
      if (reference.id.trim().length === 0) return undefined
      return { id: reference.id, access: reference.access, efforts: TASKS_EFFORT_LEVELS }
    },
  }
}
