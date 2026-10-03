import { expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createLocalSessionAttentionRoutes } from "./attention"

const auth: SignedControlPlaneAuth = { mode: "signed", user: { subject: "subject", issuer: "issuer", tokenIdentifier: "issuer:subject" } }
test("signed readers never enter the unsigned local ledger and unavailable authority remains explicit", async () => {
  const unavailable = createLocalSessionAttentionRoutes({ authenticate: async () => auth })
  expect((await unavailable.request("/api/claxedo/session-attention")).status).toBe(503)
  const listSigned = vi.fn(async () => ({ events: [], through: 50 }))
  const delegated = createLocalSessionAttentionRoutes({ authenticate: async () => auth, listSigned })
  expect(await (await delegated.request("/api/claxedo/session-attention?after=20&limit=10")).json()).toEqual({ events: [], through: 50 })
  expect(listSigned).toHaveBeenCalledWith(auth, { after: 20, limit: 10 })
})

test("invalid cursors are rejected and authentication responses remain authoritative", async () => {
  const listSigned = vi.fn(async () => ({ events: [], through: 50 }))
  const app = createLocalSessionAttentionRoutes({ authenticate: async () => auth, listSigned })
  for (const query of ["after=-1", "after=9007199254740992", "limit=257", "limit=0", "after=1.2"]) {
    expect((await app.request(`/api/claxedo/session-attention?${query}`)).status).toBe(400)
  }
  expect(listSigned).not.toHaveBeenCalled()
  const denied = createLocalSessionAttentionRoutes({ authenticate: async () => new Response("Denied", { status: 401 }) })
  expect((await denied.request("/api/claxedo/session-attention")).status).toBe(401)
})
