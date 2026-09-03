import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"

import { orgTeamErrorResponse } from "./org-team-routes"

function responseFor(error: unknown) {
  return new Hono().get("/", (context) => orgTeamErrorResponse(context, error)).request("http://test/")
}

describe("organization/team route error contract", () => {
  test.each([
    [new Error("org_admin_required"), 403, "org_admin_required"],
    [new Error("org_membership_required"), 403, "org_membership_required"],
    [new Error("team_member_org_membership_required"), 403, "team_member_org_membership_required"],
    [new Error("team_not_allowed_on_personal_org"), 400, "team_not_allowed_on_personal_org"],
    [new Error("team_member_target_required"), 400, "team_member_target_required"],
    [new Error("Organization not found"), 404, "organization_not_found"],
    [new Error("Team not found"), 404, "team_not_found"],
    [new Error("team_member_not_found"), 404, "team_member_not_found"],
    [new Error("Project not found"), 404, "project_not_found"],
    [Object.assign(new Error("authority changed"), { code: "resource_conflict" }), 409, "resource_conflict"],
    [Object.assign(new Error("additional orgs disabled"), { code: "organization_policy_denied" }), 403, "organization_policy_denied"],
  ])("maps %s to %s %s", async (error, status, code) => {
    const response = await responseFor(error)
    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ error: { code } })
  })

  test("preserves canonical authentication errors", async () => {
    const response = await responseFor(new ControlPlaneAuthError(401, "invalid_bearer_token", "Invalid token"))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_bearer_token" } })
  })

  test("does not disguise unknown implementation failures", () => {
    expect(() => orgTeamErrorResponse({} as never, new Error("database exploded"))).toThrow("database exploded")
  })
})
