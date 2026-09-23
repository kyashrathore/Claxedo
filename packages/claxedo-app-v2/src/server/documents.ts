import { queryOptions } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"
import { probeAvailability } from "./tasks"
import type { Transport } from "./transport"

export const DOCUMENTS_PATH = "/documents"

export function documentQueries(transport: Transport) {
  return {
    availability: () => queryOptions({
      queryKey: queryKeys.documents(transport.serverUrl),
      queryFn: () => probeAvailability(transport, DOCUMENTS_PATH),
    }),
  }
}
