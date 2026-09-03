import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../authority/services"
import { parseSessionListQuery, SessionListAuthorityError, sessionListErrorResponse, signedSessionList } from "./list"

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

function services(authority: Record<string, unknown>) {
  return { authority } as unknown as ControlPlaneServices
}

/** The route's own parser, so the query under test is the one a request builds. */
function query(search: string) {
  return parseSessionListQuery(new URL(`https://control.test/api/control/session-list?${search}`))
}

describe("signedSessionList", () => {
  /**
   * The registry only ever receives sessions created THROUGH it. A user-hosted
   * workspace's host holds the rest, so this read must name the runtime as the
   * authority rather than answer a truncated list the client cannot tell apart
   * from an empty workspace.
   */
  test("refuses a user-hosted workspace with the runtime named as the session authority", async () => {
    const listSessions = vi.fn(async () => [])
    const svc = services({
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "user-hosted", backing: "local-worktree", org_id: "org_1" },
      })),
      listSessions,
    })

    const error = await signedSessionList(svc, signed, query("scope=workspace&workspaceId=ws_1"))
      .then(() => undefined, (err: unknown) => err)

    expect(error).toBeInstanceOf(SessionListAuthorityError)
    expect(error).toMatchObject({ status: 409, code: "workspace_runtime_session_authority" })
    expect(listSessions).not.toHaveBeenCalled()
    expect(sessionListErrorResponse(error)?.status).toBe(409)
  })

  test("serves a cloud workspace from the registry", async () => {
    const svc = services({
      openWorkspace: vi.fn(async () => ({
        role: "owner",
        workspace: { access: "cloud", backing: "cloud-vm", org_id: "org_1" },
      })),
      listSessions: vi.fn(async () => [
        { session_id: "ses_cloud", title: "cloud", created_at: 1, updated_at: 2 },
      ]),
    })

    const response = await signedSessionList(svc, signed, query("scope=workspace&workspaceId=ws_cloud"))

    expect(response.items?.map((item) => item.sessionId)).toEqual(["ses_cloud"])
  })

  /**
   * A project can hold both kinds. The registry answers for its cloud
   * workspaces; the user-hosted ones are read by the client over their own
   * relay, so listing them here would render a truncated duplicate.
   */
  test("omits a project's user-hosted workspaces from the registry union", async () => {
    const listSessions = vi.fn(async (_auth: unknown, args: { workspaceId: string }) => [
      { session_id: `ses_${args.workspaceId}`, title: args.workspaceId, created_at: 1, updated_at: 2 },
    ])
    const svc = services({
      listWorkspaces: vi.fn(async () => [
        { workspace_id: "ws_cloud", project_id: "prj_1", access: "cloud" },
        { workspace_id: "ws_host", project_id: "prj_1", access: "user-hosted" },
      ]),
      listSessions,
    })

    const response = await signedSessionList(svc, signed, query("scope=project&projectId=prj_1"))

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith(signed, { workspaceId: "ws_cloud" })
    expect(response.items?.map((item) => item.sessionId)).toEqual(["ses_ws_cloud"])
  })
})
