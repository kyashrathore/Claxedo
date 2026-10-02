import { PublicApiError } from "@claxedo/server-core/platform/errors/public-api-error"
import { Hono } from "hono"
import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"

import { orgTeamErrorResponse } from "./org-team-routes"
import { peopleErrorResponse } from "../session-people-contract"

function responseFor(error: unknown) {
  return new Hono().get("/", (context) => orgTeamErrorResponse(context, error)).request("http://test/")
}

describe("organization/team route error contract", () => {
  test.each([
    [orgTeamErrorResponse, new PublicApiError("session_share_admin_required")],
    [peopleErrorResponse, new PublicApiError("org_admin_required")],
  ])("keeps error policy within its domain", (respond, error) => {
    expect(() => respond({ json: vi.fn(() => new Response()) } as never, error)).toThrow(error)
  })
  test("uses a typed code even when the message names a different refusal", async () => {
    const error = Object.assign(new Error("org_admin_required"), { code: "team_not_found", status: 404, retryable: false })
    expect((await responseFor(error)).status).toBe(404)
  })
  test("does not classify untyped message text", () => {
    expect(() => orgTeamErrorResponse({} as never, new Error("org_admin_required"))).toThrow("org_admin_required")
  })
  test.each([
    [new PublicApiError("org_admin_required"), 403, "org_admin_required"],
    [new PublicApiError("org_membership_required"), 403, "org_membership_required"],
    [new PublicApiError("team_member_org_membership_required"), 403, "team_member_org_membership_required"],
    [new PublicApiError("team_not_allowed_on_personal_org"), 400, "team_not_allowed_on_personal_org"],
    [new PublicApiError("team_member_target_required"), 400, "team_member_target_required"],
    [new PublicApiError("org_invitation_pending"), 409, "org_invitation_pending"],
    [new PublicApiError("team_not_found"), 404, "team_not_found"],
    [new PublicApiError("team_member_not_found"), 404, "team_member_not_found"],
    [new PublicApiError("project_not_found"), 404, "project_not_found"],
    [Object.assign(new Error("owner"), { code: "org_owner_protected" }), 409, "org_owner_protected"],
    [Object.assign(new Error("owner"), { code: "org_owner_required" }), 403, "org_owner_required"],
    [Object.assign(new Error("member"), { code: "org_member_not_found" }), 404, "org_member_not_found"],
    [Object.assign(new Error("admin"), { code: "project_admin_required" }), 403, "project_admin_required"],
    [Object.assign(new Error("member"), { code: "project_member_not_found" }), 404, "project_member_not_found"],
    [Object.assign(new Error("org"), { code: "project_member_org_membership_required" }), 403, "project_member_org_membership_required"],
    [Object.assign(new Error("owner"), { code: "project_member_owner_immutable" }), 409, "project_member_owner_immutable"],
    [Object.assign(new Error("bad"), { code: "invalid_input" }), 400, "invalid_input"],
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
