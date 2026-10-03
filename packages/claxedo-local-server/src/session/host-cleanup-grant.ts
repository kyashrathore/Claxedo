import type { SessionCleanupGrant } from "@claxedo/mcp"
import { hostServingPublisherCredential } from "@claxedo/host-serving/serving"
import { localHostSessionRowsUrl } from "../deployments/local/host-session-authority"

export function hostSessionCleanupGrant(input: { workspaceId: string; sessionId: string; ownerDriven(): boolean; send?: (request: URL, init?: RequestInit) => Promise<Response> }): SessionCleanupGrant {
  let current: { token: string; expiresAt: number; binding: string } | undefined
  let pending: Promise<{ token: string; expiresAt: number; binding: string }> | undefined
  const send = input.send ?? fetch
  const identity = () => {
    const credential = hostServingPublisherCredential()
    const endpoint = localHostSessionRowsUrl()
    if (!credential || !endpoint || !input.ownerDriven()) return undefined
    const scope = credential.workspaceIds.includes(input.workspaceId) ? "session" : "machine"
    return { credential, scope, origin: new URL(endpoint).origin, binding: `${credential.hostId}/${credential.token}/${scope}` }
  }
  async function grant(bound: NonNullable<ReturnType<typeof identity>>) {
    if (current?.binding === bound.binding && current.expiresAt - Date.now() > 30_000) return current
    if (pending) return pending
    pending = (async () => {
      const response = await send(new URL("/api/claxedo/session-cleanup/grant", bound.origin), {
        method: "POST", headers: { authorization: `Bearer ${bound.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify(bound.scope === "session"
          ? { scope: "session", hostId: bound.credential.hostId, workspaceId: input.workspaceId, sessionId: input.sessionId }
          : { scope: "machine", hostId: bound.credential.hostId }),
      })
      if (!response.ok) throw new Error(`Cleanup capability issuance was refused (${response.status})`)
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string" || !("expiresAt" in body) || typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) throw new Error("Cleanup capability issuer returned an invalid grant")
      current = { token: body.token, expiresAt: body.expiresAt, binding: bound.binding }
      return current
    })()
    try { return await pending } finally { pending = undefined }
  }
  return {
    allowed: () => identity() !== undefined,
    fetch: async (path, init) => {
      const bound = identity()
      if (!bound) return Response.json({ error: { code: "cleanup_capability_unavailable", message: "The machine's account cleanup authority is unavailable" } }, { status: 503 })
      let held: Awaited<ReturnType<typeof grant>>
      try { held = await grant(bound) } catch (error) {
        return Response.json({ error: { code: "cleanup_capability_unavailable", message: error instanceof Error ? error.message : String(error) } }, { status: 503 })
      }
      const now = identity()
      if (now?.binding !== bound.binding) return Response.json({ error: { code: "cleanup_capability_changed", message: "The machine owner or enrollment changed" } }, { status: 409 })
      const url = new URL(path, bound.origin)
      if (url.origin !== bound.origin || (url.pathname !== "/api/claxedo/session-cleanup" && url.pathname !== "/api/claxedo/session-cleanup/delete")) throw new Error("Cleanup capability cannot reach this route")
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${held.token}`)
      return send(url, { ...init, headers, redirect: "manual" })
    },
  }
}
