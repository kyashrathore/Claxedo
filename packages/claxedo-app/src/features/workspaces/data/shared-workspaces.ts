import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"

export const SHARED_WORKSPACES_QUERY_KEY = ["claxedo", "remote-access", "shared-workspaces"] as const

/**
 * Which local workspaces this machine's account has published for remote access.
 *
 * Each product answers from its OWN authority, and the two are genuinely
 * different facts rather than a preference order:
 *
 *   - Where the port can enumerate the account's machines (`devices`, the
 *     self-hosted/browser product), a workspace is shared exactly when some
 *     enrolled machine lists it — that is an account-wide answer.
 *   - Where it cannot (the desktop, whose connector knows only itself), the
 *     connector's own status carries `sharedWorkspaceIds`, which is the
 *     complete truth for the one machine that exists there.
 *
 * Absent port (unsigned, or a product without the connector) reads as an
 * empty set, not an error: "nothing is shared" is the truthful answer there.
 */
export type PublishedWorkspaces = {
  /** Whether this account is publishing a machine at all right now. */
  publishing: boolean
  ids: readonly string[]
}

export function useSharedWorkspaceIds() {
  const query = useQuery(() => ({
    queryKey: SHARED_WORKSPACES_QUERY_KEY,
    queryFn: async (): Promise<PublishedWorkspaces> => {
      const port = machineRemoteAccess()
      if (!port) return { publishing: false, ids: [] }
      if (port.devices) {
        const devices = await port.devices()
        return {
          publishing: devices.length > 0,
          ids: [...new Set(devices.flatMap((device) => [...device.workspaceIds]))],
        }
      }
      const status = await port.status()
      return { publishing: status.enabled, ids: [...(status.sharedWorkspaceIds ?? [])] }
    },
    staleTime: 30_000,
    retry: false,
  }))
  const shared = (workspaceId: string | undefined) =>
    !!workspaceId && (query.data?.ids ?? []).includes(workspaceId)
  return {
    /**
     * The published set, or `undefined` while it is still unknown.
     *
     * The distinction matters to the auto-share reconciler: "nothing is
     * published yet" and "we have not been told yet" would otherwise look the
     * same, and the reconciler would try to publish every workspace on the
     * machine against a set it had not read.
     */
    ids: () => query.data?.ids,
    /**
     * Whether a share could succeed right now, from the SAME read that
     * produced the published set.
     *
     * The reconciler needs this to avoid posting an assignment at a machine
     * that is idle, paused or revoked — every one of those would reject, and
     * the user would read a failure for a feature they never turned on. Asking
     * the port a second time would let the two answers disagree.
     */
    publishing: () => query.data?.publishing,
    shared,
    refetch: () => query.refetch(),
  }
}

/** Invalidate after a successful share so every row learns immediately. */
export function invalidateSharedWorkspaces(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: SHARED_WORKSPACES_QUERY_KEY })
}
