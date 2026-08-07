import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey } from "./session-config-selection"

export function setSessionConfigRawQueryData(sessionID: string, config: unknown) {
  queryClient.setQueryData(sessionConfigRawQueryKey(sessionID), config)
}
