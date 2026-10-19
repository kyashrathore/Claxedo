import { bearerToken, trimToUndefined } from "@claxedo/helpers/string"

export { bearerToken }

export function errorBody(code: string, message: string) {
  return {
    error: {
      code,
      message,
    },
  }
}

/** The host a tunnel request names, `/host-tunnels/<hostId>`. */
export function hostIdFromTunnelPath(pathname: string) {
  return /^\/host-tunnels\/([^/]+)(?:\/|$)/.exec(pathname)?.[1]
}

/** The workspaces a tunnel request registers for, under either spelling of the query name. */
export function workspaceIdsFromSearch(url: URL) {
  return [...new Set([
    ...url.searchParams.getAll("workspaceId"),
    ...url.searchParams.getAll("workspace_id"),
  ].map(trimToUndefined).filter((item): item is string => !!item))]
}
