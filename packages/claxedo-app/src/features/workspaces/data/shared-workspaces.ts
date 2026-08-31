import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"

export const SHARED_WORKSPACES_QUERY_KEY = ["claxedo", "remote-access", "shared-workspaces"] as const

/**
 * Which local workspaces this account has published for remote access.
 *
 * The enrolled devices are the authority: each device row carries the
 * workspace ids it serves, and a workspace is "shared" exactly when some
 * enrolled machine lists it. Before this, a shared workspace looked identical
 * to an unshared one — the only feedback ever shown was a transient toast at
 * the moment of sharing.
 *
 * Absent port (unsigned, or a product without the connector) reads as an
 * empty set, not an error: "nothing is shared" is the truthful answer there.
 */
export function useSharedWorkspaceIds() {
  const query = useQuery(() => ({
    queryKey: SHARED_WORKSPACES_QUERY_KEY,
    queryFn: async () => {
      const port = machineRemoteAccess()
      if (!port?.devices) return [] as string[]
      const devices = await port.devices()
      return [...new Set(devices.flatMap((device) => [...device.workspaceIds]))]
    },
    staleTime: 30_000,
    retry: false,
  }))
  const shared = (workspaceId: string | undefined) =>
    !!workspaceId && (query.data ?? []).includes(workspaceId)
  return { shared, refetch: () => query.refetch() }
}

/** Invalidate after a successful share so every row learns immediately. */
export function invalidateSharedWorkspaces(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: SHARED_WORKSPACES_QUERY_KEY })
}
