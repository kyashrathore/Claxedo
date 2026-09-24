import { probeAvailability } from "./availability"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FeatureAvailability } from "./types"

export const TASKS_PRESETS_PATH = "/api/claxedo/tasks/presets"

export function taskQueries(transport: Transport) {
  return {
    availability: () => fetchQuery<FeatureAvailability>(queryKeys.tasks(transport.serverUrl), () => probeAvailability(transport, TASKS_PRESETS_PATH)),
  }
}
