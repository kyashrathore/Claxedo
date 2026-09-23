import { queryOptions } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"

export const TASKS_PATH = "/api/claxedo/tasks"

export type FeatureAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string }

export async function probeAvailability(transport: Transport, path: string): Promise<FeatureAvailability> {
  const response = await transport.request(path)
  if (response.ok) return { kind: "available" }
  const reason = (await response.text().catch(() => "")).trim() || `${path} answered ${response.status}`
  return { kind: "unavailable", reason }
}

export function taskQueries(transport: Transport) {
  return {
    availability: () => queryOptions({
      queryKey: queryKeys.tasks(transport.serverUrl),
      queryFn: () => probeAvailability(transport, `${TASKS_PATH}/presets`),
    }),
  }
}
