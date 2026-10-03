import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { SessionId } from "./ids"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import { localSessionLocationFromWire } from "./wire/session-location"
import type { Workspaces } from "./workspaces"
import type { SessionLocation, FetchQuery } from "./types"

export function localSessionLocationQuery(transport: Transport, workspaces: Workspaces, sessionId: SessionId): FetchQuery<SessionLocation> {
  return {
    ...fetchQuery<SessionLocation>(queryKeys.localSessionLocation(transport.serverUrl, sessionId), async () => {
      const input = await transport.json<unknown>(`/api/claxedo/session/${encodeURIComponent(sessionId)}/location`)
      const ref = localSessionLocationFromWire(input, sessionId)
      await workspaces.load()
      const placement = workspaces.byId(ref.placementId)
      const record = workspaces.catalog()?.placements.find((item) => item.placement.id === ref.placementId)
      if (!placement || placement.kind === "cloud" || record?.route.remote !== false || placement.projectId !== ref.projectId) {
        throw new ServerError({ class: "not_found", message: "The local session's placement is unavailable" })
      }
      return ref
    }),
    staleTime: 0,
    retry: false,
  }
}
