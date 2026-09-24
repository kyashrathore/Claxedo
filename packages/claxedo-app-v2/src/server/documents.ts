import { probeAvailability } from "./availability"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import type { FeatureAvailability } from "./types"

export const DOCUMENTS_PATH = "/documents"

export function documentQueries(transport: Transport) {
  return {
    availability: () => fetchQuery<FeatureAvailability>(queryKeys.documents(transport.serverUrl), () => probeAvailability(transport, DOCUMENTS_PATH)),
  }
}
