import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../authority/services"
import { parseSessionListQuery, sessionListErrorResponse, signedSessionList } from "./list"

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

function services(authority: Record<string, unknown>) {
  return { authority } as unknown as ControlPlaneServices
}

function query(search: string) {
  return parseSessionListQuery(new URL(`https://control.test/api/control/session-list?${search}`))
}

function row(sessionId: string, workspaceId: string, lastHumanTurnAt?: number) {
  return {
    session_id: sessionId,
    workspace_id: workspaceId,
    project_id: "prj_1",
    created_at: 1,
    updated_at: 2,
    ...(lastHumanTurnAt === undefined ? {} : { last_human_turn_at: lastHumanTurnAt }),
  }
}

describe("signedSessionList", () => {
  test("reads one keyset page of the project across its cloud and machine workspaces", async () => {
    const listSessionPage = vi.fn(async () => [row("ses_cloud", "ws_cloud", 9), row("ses_host", "ws_host", 5), row("ses_more", "ws_host")])
    const response = await signedSessionList(
      services({ listSessionPage }),
      signed,
      query("scope=project&projectId=prj_1&sort=human_turn_desc&limit=2"),
    )

    expect(listSessionPage).toHaveBeenCalledWith(signed, {
      projectId: "prj_1",
      sort: "human_turn_desc",
      archived: "active",
      limit: 3,
    })
    expect(response.items?.map((item) => item.sessionRef)).toEqual([
      "workspace:ws_cloud:session:ses_cloud",
      "workspace:ws_host:session:ses_host",
    ])
    expect(response.nextCursor).toBeTypeOf("string")
  })

  test("resumes the keyset from the cursor's row", async () => {
    const listSessionPage = vi.fn(async () => [row("ses_a", "ws_1", 9), row("ses_b", "ws_1", 5)])
    const first = await signedSessionList(services({ listSessionPage }), signed, query("scope=workspace&workspaceId=ws_1&sort=human_turn_desc&limit=1"))
    listSessionPage.mockResolvedValueOnce([row("ses_b", "ws_1", 5)])

    await signedSessionList(
      services({ listSessionPage }),
      signed,
      query(`scope=workspace&workspaceId=ws_1&sort=human_turn_desc&limit=1&cursor=${first.nextCursor}`),
    )

    expect(listSessionPage).toHaveBeenLastCalledWith(signed, {
      workspaceId: "ws_1",
      sort: "human_turn_desc",
      archived: "active",
      limit: 2,
      after: { updatedAt: 2, createdAt: 1, lastHumanTurnAt: 9, sessionRef: "workspace:ws_1:session:ses_a" },
    })
  })

  test("refuses a view the registry's rows cannot answer", async () => {
    const listSessionPage = vi.fn(async () => [])
    const error = await signedSessionList(services({ listSessionPage }), signed, query("scope=project&projectId=prj_1&groupBy=workspace"))
      .then(() => undefined, (err: unknown) => err)

    expect(sessionListErrorResponse(error)?.status).toBe(400)
    expect(listSessionPage).not.toHaveBeenCalled()
  })

  test("refuses a list that names neither a project nor a workspace", async () => {
    const error = await signedSessionList(services({ listSessionPage: vi.fn() }), signed, query("scope=global"))
      .then(() => undefined, (err: unknown) => err)

    expect(sessionListErrorResponse(error)?.status).toBe(400)
  })

  test("refuses a cursor minted for another query", async () => {
    const listSessionPage = vi.fn(async () => [row("ses_a", "ws_1", 9), row("ses_b", "ws_1", 5)])
    const first = await signedSessionList(services({ listSessionPage }), signed, query("scope=workspace&workspaceId=ws_1&limit=1"))

    const error = await signedSessionList(
      services({ listSessionPage }),
      signed,
      query(`scope=workspace&workspaceId=ws_2&limit=1&cursor=${first.nextCursor}`),
    ).then(() => undefined, (err: unknown) => err)

    expect(sessionListErrorResponse(error)?.status).toBe(400)
  })
})
