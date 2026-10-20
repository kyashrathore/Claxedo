import type { RuntimeRoute, Transport } from "./transport"
import type { SessionLocation } from "./types"
import type { PlacementRecord } from "./wire/placements"

export type SessionHosts = { readonly roots: Map<string, string>; readonly askedOrServedByWorkspace: Map<string, Promise<unknown>>; readonly learned: Set<() => void> }

export function rememberSessionHost(hosts: SessionHosts, key: string, root: string) {
  if (hosts.roots.get(key) === root) return
  hosts.roots.set(key, root)
  for (const listener of hosts.learned) listener()
}

export const sessionHostKey = (ref: Pick<SessionLocation, "placementId" | "sessionId">) => JSON.stringify([ref.placementId, ref.sessionId])

export function hostedRoute(record: PlacementRecord, hosts: SessionHosts, ref: Pick<SessionLocation, "placementId" | "sessionId">): RuntimeRoute | undefined {
  const root = hosts.roots.get(sessionHostKey(ref))
  return root ? { ...record.route, sessionHost: { sessionId: root } } : undefined
}

export type HostFinder = Transport["findSessionHost"]

export function cloudSessionHosts(find: HostFinder, hosts: SessionHosts) {
  return async (record: PlacementRecord, ref: Pick<SessionLocation, "placementId" | "sessionId">) => {
    if (record.placement.kind !== "cloud") return hostedRoute(record, hosts, ref)
    const key = sessionHostKey(ref)
    const pending = hosts.askedOrServedByWorkspace.get(key) ?? find(record.route.workspaceId, ref.sessionId).then((root) => {
      if (root) rememberSessionHost(hosts, key, root)
    }, (error: unknown) => {
      hosts.askedOrServedByWorkspace.delete(key)
      throw error
    })
    hosts.askedOrServedByWorkspace.set(key, pending)
    await pending
    return hostedRoute(record, hosts, ref)
  }
}
