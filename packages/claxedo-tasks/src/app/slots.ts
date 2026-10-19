import type { ConfigurationSlot } from "../contracts"
import type { TasksKey } from "./dictionary"

export const SLOT_KEYS: Readonly<Record<ConfigurationSlot, TasksKey>> = {
  primary: "claxedo-tasks.preset.slot.primary",
  planning: "claxedo-tasks.preset.slot.planning",
  implementation: "claxedo-tasks.preset.slot.implementation",
  review: "claxedo-tasks.preset.slot.review",
}
