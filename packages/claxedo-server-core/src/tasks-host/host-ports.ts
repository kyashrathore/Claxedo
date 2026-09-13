import { randomUUID } from "node:crypto"
import { HARNESS_EFFORT_LEVELS } from "@claxedo/agent-runtime-contract"
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
    // The contract's own vocabulary, so a saved preset cannot name a word the
    // runtime's `variant` field could never mean. Whether the CHOSEN model
    // honours the word is the session bridge's answer at preview and start:
    // this list admits every level some harness runs.
    async harness(reference: HarnessReference) {
      if (reference.id.trim().length === 0) return undefined
      return { id: reference.id, access: reference.access, efforts: HARNESS_EFFORT_LEVELS }
    },
  }
}
