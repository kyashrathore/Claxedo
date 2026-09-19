import { describe, expect, test, vi } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import type { ControlPlaneServices } from "../../authority/services"
import { ControlPlaneSessionRoutes } from "./control-plane-session"
import { SessionPeopleControlRoutes } from "./session-people-routes"
import type { SessionShareChangedSink, SessionShareFanoutTarget } from "../session-people-contract"

const signedOptions = {
  authConfig: {
    enabled: true as const,
    issuer: "https://auth.example.test",
    jwksUrl: "custom:test",
  },
  verifier: vi.fn(async (token: string) => ({
    mode: "signed" as const,
    token,
    user: {
      subject: "user_alice",
      tokenIdentifier: "https://auth.example.test|user_alice",
      issuer: "https://auth.example.test",
    },
  })),
}

function services(authority: Partial<WorkspaceAuthority>): ControlPlaneServices {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: localOnlyAuthAdapter(),
    authority: authority as WorkspaceAuthority,
    credentials: {} as never,
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
  }
}

type RouteFactory = (
  services: ControlPlaneServices,
  options: typeof signedOptions & { sessionShareChangedSink?: SessionShareChangedSink },
) => { request: (url: string, init: RequestInit) => Response | Promise<Response> }

const routeFactories: ReadonlyArray<readonly [string, RouteFactory]> = [
  ["central", ControlPlaneSessionRoutes as RouteFactory],
  ["worker-safe", SessionPeopleControlRoutes as RouteFactory],
]

async function postShare(
  routeFactory: RouteFactory,
  authority: Partial<WorkspaceAuthority>,
) {
  return routeFactory(services(authority), signedOptions).request(
    "https://control.example.test/sessions/ses_1/shares",
    {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_1", grantedToTokenIdentifier: "missing" }),
    },
  )
}

describe("People route contract", () => {
  const errors = [
    { thrown: "Session not found", status: 404, code: "session_not_found" },
    { thrown: "session_share_admin_required", status: 403, code: "session_share_admin_required" },
    { thrown: "session_share_target_required", status: 400, code: "session_share_target_required" },
    { thrown: "session_share_target_not_found", status: 404, code: "session_share_target_not_found" },
    {
      thrown: "session_participant_workspace_access_required",
      status: 403,
      code: "session_participant_workspace_access_required",
    },
    {
      thrown: "session_share_send_workspace_write_required",
      status: 403,
      code: "session_share_send_workspace_write_required",
    },
    { thrown: "session_share_team_org_mismatch", status: 400, code: "session_share_team_org_mismatch" },
    { thrown: "session_share_org_mismatch", status: 400, code: "session_share_org_mismatch" },
  ] as const

  for (const [name, routeFactory] of routeFactories) {
    for (const error of errors) {
      test(`${name} maps ${error.code} to the canonical envelope`, async () => {
        const response = await postShare(routeFactory, {
          grantSessionShare: vi.fn(async () => {
            throw new Error(error.thrown)
          }),
        })

        expect(response.status).toBe(error.status)
        await expect(response.json()).resolves.toMatchObject({
          error: { code: error.code, message: expect.any(String) },
        })
      })
    }
  }
})

const fanoutCases: Array<{
  name: string
  target: SessionShareFanoutTarget
  authority: Partial<WorkspaceAuthority>
}> = [
  {
    name: "direct user",
    target: { grantedToTokenIdentifier: "https://auth.example.test|user_bob" },
    authority: {},
  },
  {
    name: "team",
    target: { grantedToTeamPublicId: "team_eng" },
    authority: {
      listTeamMembers: vi.fn(async () => [
        { token_identifier: "https://auth.example.test|user_bob" },
      ]),
    },
  },
  {
    name: "org",
    target: { grantedToOrgId: "org_internal" },
    authority: {
      listTeams: vi.fn(async () => [{ team_id: "team_eng" }]),
      listTeamMembers: vi.fn(async () => [
        { token_identifier: "https://auth.example.test|user_bob" },
      ]),
    },
  },
]

describe("grantId-only revoke fanout", () => {
  for (const [routeName, routeFactory] of routeFactories) {
    for (const fanout of fanoutCases) {
      test(`${routeName} notifies the canonical ${fanout.name} target returned by revoke`, async () => {
        const sink = vi.fn()
        const authority: Partial<WorkspaceAuthority> = {
          resolveOrgId: vi.fn(async () => "org_internal" as OrgId),
          ...fanout.authority,
          revokeSessionShare: vi.fn(async () => ({
            revoked: true,
            runtime_tokens_revoked: 1,
            revokedTargets: [fanout.target],
          })),
        }
        const response = await routeFactory(services(authority), {
          ...signedOptions,
          sessionShareChangedSink: sink,
        }).request("https://control.example.test/sessions/ses_1/shares", {
          method: "DELETE",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "ws_1", grantId: "ssg_1" }),
        })

        expect(response.status).toBe(200)
        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
          type: "session.share.changed",
          phase: "revoked",
          ownerUserId: "user_bob",
          sessionId: "ses_1",
          workspaceId: "ws_1",
        }))
      })
    }
  }
})

describe("share level on the grant route", () => {
  for (const [routeName, routeFactory] of routeFactories) {
    test(`${routeName} passes the requested level through and rings the doorbell with it`, async () => {
      const sink = vi.fn()
      const grantSessionShare = vi.fn(async () => ({ grant_id: "ssg_1", level: "send" as const }))
      const response = await routeFactory(
        services({
          grantSessionShare,
          resolveOrgId: vi.fn(async () => "org_internal" as OrgId),
        }),
        { ...signedOptions, sessionShareChangedSink: sink },
      ).request("https://control.example.test/sessions/ses_1/shares", {
        method: "POST",
        headers: { authorization: "Bearer token", "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws_1",
          level: "send",
          grantedToTokenIdentifier: "https://auth.example.test|user_bob",
        }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ grant_id: "ssg_1", level: "send" })
      expect(grantSessionShare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "send" }))
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ phase: "granted", level: "send" }))
    })

    test(`${routeName} defaults a level-less grant to follow`, async () => {
      const grantSessionShare = vi.fn(async () => ({ grant_id: "ssg_1", level: "follow" as const }))
      const response = await routeFactory(services({ grantSessionShare }), signedOptions).request(
        "https://control.example.test/sessions/ses_1/shares",
        {
          method: "POST",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId: "ws_1",
            grantedToTokenIdentifier: "https://auth.example.test|user_bob",
          }),
        },
      )

      expect(response.status).toBe(200)
      expect(grantSessionShare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ level: "follow" }))
    })

    test(`${routeName} refuses an unknown level before reaching the authority`, async () => {
      const grantSessionShare = vi.fn(async () => ({ grant_id: "ssg_1", level: "follow" as const }))
      const response = await routeFactory(services({ grantSessionShare }), signedOptions).request(
        "https://control.example.test/sessions/ses_1/shares",
        {
          method: "POST",
          headers: { authorization: "Bearer token", "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId: "ws_1",
            level: "broadcast",
            grantedToTokenIdentifier: "https://auth.example.test|user_bob",
          }),
        },
      )

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "session_share_level_invalid" } })
      expect(grantSessionShare).not.toHaveBeenCalled()
    })
  }
})
