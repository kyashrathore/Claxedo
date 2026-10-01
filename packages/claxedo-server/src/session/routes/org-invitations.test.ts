import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../../authority/services"
import { testRequestAuthenticationAdapter } from "../../test-support/request-authentication"
import { OrgTeamControlRoutes } from "./org-team-routes"

function setup() {
  const createOrgInvitation = vi.fn(async () => undefined)
  const addOrgMember = vi.fn(async () => ({ user_id: "user", role: "member" }))
  const app = OrgTeamControlRoutes(
    { authority: { createOrgInvitation, addOrgMember } } as unknown as ControlPlaneServices,
    {
      authentication: testRequestAuthenticationAdapter(),
    },
  )
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { app, post, createOrgInvitation, addOrgMember }
}

describe("organization invitation routes", () => {
  test("known and unknown addresses receive identical 202 bodies", async () => {
    const { post, createOrgInvitation } = setup()
    const known = await post("/orgs/org/invitations", { email: "known@example.com", role: "admin" })
    const unknown = await post("/orgs/org/invitations", { email: "unknown@example.com", role: "admin" })
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await known.json()).toEqual({ message: "invitation sent" })
    expect(await unknown.json()).toEqual({ message: "invitation sent" })
    expect(createOrgInvitation).toHaveBeenCalledTimes(2)
  })

  test("the direct member-add route no longer exists", async () => {
    const { post, addOrgMember } = setup()
    const response = await post("/orgs/org/members", { email: "known@example.com", role: "member" })
    expect(response.status).toBe(404)
    expect(addOrgMember).not.toHaveBeenCalled()
  })

  test("acceptance requires signed authentication", async () => {
    const { app } = setup()
    expect((await app.request("/invitations/token/accept", { method: "POST" })).status).toBe(401)
  })
})
