import { placementId, projectId, sessionId } from "../ids"
import type { Transport } from "../transport"
import type { Workspaces } from "../workspaces"

export async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
}

export function openBody(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { "content-type": "text/event-stream" } })
}

export const placement = placementId("ws_shared")
export const record = {
  placement: { id: placement, projectId: projectId("prj"), kind: "worktree", label: "Shared", reachable: true },
  route: { directory: "workspace:ws_shared", workspaceId: "ws_shared", remote: true },
}
export const home = async () => ({ route: record.route, central: false, live: true })
export const workspaces = { streamRoute: () => record.route, home, refresh: async () => undefined, onSessionHostLearned: () => () => undefined } as unknown as Workspaces

export function ref(id: string) {
  return { projectId: projectId("prj"), placementId: placement, sessionId: sessionId(id) }
}

export function streamTransport(fields: object): Transport {
  return { onRuntimeImage: () => () => undefined, ...fields } as unknown as Transport
}
