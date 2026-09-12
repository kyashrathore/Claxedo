import type { HarnessReference, PresetPlacement } from "../contracts"

export type HarnessDescriptor = {
  id: string
  access: "native" | "connection"
  /** The effort levels this harness advertises. Empty means it accepts no explicit effort. */
  efforts: readonly string[]
}

export type TasksHostCapabilities = {
  placements: readonly PresetPlacement[]
  /** False on a host that cannot isolate a cloud root; such a preset saves but cannot start. */
  cloudSelectedCapabilities: boolean
  instructions: boolean
}

/**
 * What the host can actually do, read at save time for structural validation
 * only. Model, plugin and skill availability for a concrete target is the
 * session bridge's answer at preview/start, never a saved-preset check.
 */
export type TasksCapabilitiesPort = {
  describe(): Promise<TasksHostCapabilities>
  harness(reference: HarnessReference): Promise<HarnessDescriptor | undefined>
}
