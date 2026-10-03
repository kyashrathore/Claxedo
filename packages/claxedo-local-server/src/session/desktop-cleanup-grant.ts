import { Hono } from "hono"
import { z } from "zod"
import type { SessionCleanupGrant } from "@claxedo/mcp"
import { DAEMON_PROTOCOL_HEADER } from "@claxedo/helpers/claxedo-daemon"
import { DAEMON_CAPABILITY_HEADER, daemonSecretMatches } from "../app/daemon-admission"

const capabilitySchema = z.strictObject({
  token: z.string().min(1).max(8_000),
  expiresAt: z.number().int().positive(),
  actorId: z.string().min(1).max(300),
  orgId: z.string().min(1).max(300),
  origin: z.string().url().max(2_000),
})

export function createDesktopSessionCleanupAccess(input: {
  daemonToken: string
  protocol: number
  hostOwnerActorId(): string | undefined
  send?: (request: URL, init?: RequestInit) => Promise<Response>
}) {
  let held: z.infer<typeof capabilitySchema> | undefined
  let unavailable: string | undefined
  const send = input.send ?? fetch
  const current = () => {
    if (!held || held.expiresAt <= Date.now()) return undefined
    const hostOwner = input.hostOwnerActorId()
    return hostOwner && hostOwner !== held.actorId ? undefined : held
  }
  const grant: SessionCleanupGrant = {
    allowed: () => current() !== undefined,
    fetch: async (path, init) => {
      const bound = current()
      if (!bound) return Response.json({ error: { code: "cleanup_capability_unavailable", message: unavailable ?? "The desktop's signed account cleanup authority is unavailable" } }, { status: 503 })
      const url = new URL(path, bound.origin)
      if (url.origin !== bound.origin || (url.pathname !== "/api/claxedo/session-cleanup" && url.pathname !== "/api/claxedo/session-cleanup/delete")) throw new Error("Cleanup capability cannot reach this route")
      const headers = new Headers(init?.headers)
      headers.set("authorization", `Bearer ${bound.token}`)
      return send(url, { ...init, headers, redirect: "manual" })
    },
  }
  const routes = new Hono().put("/", async (c) => {
    if (!daemonSecretMatches(c.req.header(DAEMON_CAPABILITY_HEADER), input.daemonToken)) {
      return c.json({ error: { code: "daemon_identity_unauthorized", message: "Daemon token is invalid" } }, 401)
    }
    if (Number(c.req.header(DAEMON_PROTOCOL_HEADER)) !== input.protocol) {
      return c.json({ error: { code: "daemon_protocol_incompatible", message: "The daemon management protocol changed" } }, 426)
    }
    const parsed = z.strictObject({ capability: capabilitySchema.nullable(), unavailable: z.string().trim().min(1).max(3_000).optional() })
      .refine((body) => body.capability === null || body.unavailable === undefined)
      .safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "invalid_cleanup_capability", message: "The desktop cleanup capability failed validation" } }, 400)
    const next = parsed.data.capability
    if (next) {
      const origin = new URL(next.origin)
      if (origin.origin !== next.origin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) || next.expiresAt <= Date.now()) {
        return c.json({ error: { code: "invalid_cleanup_capability", message: "The cleanup issuer origin or expiry is invalid" } }, 400)
      }
    }
    held = next ?? undefined
    unavailable = parsed.data.unavailable
    return c.json({ ok: true, authenticated: current() !== undefined })
  })
  return { routes, grant, configured: () => held !== undefined || unavailable !== undefined, ownerActorId: () => current()?.actorId }
}
