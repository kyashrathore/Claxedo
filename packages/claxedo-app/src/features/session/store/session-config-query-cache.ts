import { queryClient } from "@/platform/query/query-client"
import { sessionConfigRawQueryKey, type SessionConfigQueryScope } from "./session-config-selection"

export function setSessionConfigRawQueryData(scope: SessionConfigQueryScope, config: unknown) {
  queryClient.setQueryData(sessionConfigRawQueryKey(scope), config)
}
