import { createWorkspaceConnections } from "./transport"

export function connectionReads(body: unknown) {
  const calls: { path: string; method: string | undefined }[] = []
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method })
    return Response.json(body)
  }
  return { read: createWorkspaceConnections(request).read, calls }
}

export const link = { workspaceId: "ws_1", relayUrl: "https://relay.test", runtimeAccessToken: "rat", tokenExpiresAt: Date.now() + 3_600_000 }

export function tab() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), items }
}
