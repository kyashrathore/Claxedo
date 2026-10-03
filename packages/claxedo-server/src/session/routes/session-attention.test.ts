import { expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSessionAttentionRoutes } from "./session-attention"

const auth: SignedControlPlaneAuth = { mode: "signed", user: { subject: "reader", tokenIdentifier: "issuer|reader", issuer: "issuer" } }

test("the public recovery route passes the signed identity and bounded cursor to authority", async () => {
  const listSessionAttention = vi.fn(async () => ({ events: [], through: 41 }))
  const app = createSessionAttentionRoutes({ authenticate: async () => auth, authority: { listSessionAttention } })
  const response = await app.request("http://control.test/session-attention?after=12&limit=30")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ events: [], through: 41 })
  expect(listSessionAttention).toHaveBeenCalledWith(auth, { after: 12, limit: 30 })
})

test("refuses anonymous requests, invalid pages and an unavailable history owner", async () => {
  const listSessionAttention = vi.fn(async () => ({ events: [], through: 0 }))
  const denied = createSessionAttentionRoutes({ authenticate: async () => new Response("Unauthorized", { status: 401 }), authority: { listSessionAttention } })
  expect((await denied.request("http://control.test/session-attention")).status).toBe(401)
  expect(listSessionAttention).not.toHaveBeenCalled()
  const app = createSessionAttentionRoutes({ authenticate: async () => auth, authority: { listSessionAttention } })
  for (const query of ["after=-1", "after=2e3", "after=9007199254740992", "limit=0", "limit=257"]) {
    expect((await app.request(`http://control.test/session-attention?${query}`)).status).toBe(400)
  }
  expect(listSessionAttention).not.toHaveBeenCalled()
  const unavailable = createSessionAttentionRoutes({ authenticate: async () => auth, authority: {} })
  expect((await unavailable.request("http://control.test/session-attention")).status).toBe(503)
})
