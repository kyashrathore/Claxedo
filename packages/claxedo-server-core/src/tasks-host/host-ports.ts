/**
 * What a host supplies to the Tasks kit besides its store, authority and
 * session bridge: the clock every persisted timestamp comes from, the id mint
 * every row identity comes from, and the structural capability answer a preset
 * is validated against when it is saved.
 */
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
 * The effort vocabulary a saved preset may name. Whether the model a slot
 * ends up running honours one of them is per model and per harness, and the
 * session bridge answers that at preview; this list only keeps a preset from
 * storing a word the runtime's `variant` field could never mean.
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
        instructions: true,
      }
    },
    async harness(reference: HarnessReference) {
      if (reference.id.trim().length === 0) return undefined
      return { id: reference.id, access: reference.access, efforts: TASKS_EFFORT_LEVELS }
    },
  }
}
