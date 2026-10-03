import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../authority/services"
import { parseSessionListQuery, sessionListErrorResponse, signedSessionList } from "./list"

const signed = {
  mode: "signed" as const,
  token: "user_1",
  user: { subject: "user_1", tokenIdentifier: "issuer|user_1", issuer: "issuer" },
}

function services(authority: Record<string, unknown>) {
  return { authority: { countSessions: vi.fn(async () => (3)), ...authority } } as unknown as ControlPlaneServices
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
  test("passes an exact navigation identity to both the authoritative page and count query", async () => {
    const rich = { ...row("ses_off_page", "ws_1"), ownership: "owned", projectName: "Acme",
      placement: { kind: "machine", machineId: "host_1", machineName: "Desktop" } }
    const listSessionPage = vi.fn(async () => [rich])
    const countSessions = vi.fn(async () => (1))
    const response = await signedSessionList(services({ listSessionPage, countSessions }), signed,
      query("scope=workspace&workspaceId=ws_1&sessionId=ses_off_page&limit=2&settled=all&seen=all"))
    const exact = { sessionId: "ses_off_page", workspaceId: "ws_1", limit: 3, settled: "all", seen: "all" }
    expect(listSessionPage).toHaveBeenCalledWith(signed, expect.objectContaining(exact))
    expect(countSessions).toHaveBeenCalledWith(signed, expect.objectContaining(exact))
    expect(response).toMatchObject({ items: [{ sessionId: "ses_off_page", projectName: "Acme", placement: rich.placement }], totalKnown: 1 })
    expect(response.nextCursor).toBeUndefined()
  })

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
      settled: "active",
      ownership: "all",
      seen: "all",
      limit: 3,
    })
    expect(response.items?.map((item) => item.sessionRef)).toEqual([
      "workspace:ws_cloud:session:ses_cloud",
      "workspace:ws_host:session:ses_host",
    ])
    expect(response.nextCursor).toBeTypeOf("string")
    expect(response.totalKnown).toBe(3)
  })

  test("refuses unavailable counts instead of reporting the page window as a total", async () => {
    const listSessionPage = vi.fn()
    const error = await signedSessionList(services({ listSessionPage, countSessions: undefined }), signed, query("scope=all"))
      .then(() => undefined, (err: unknown) => err)
    expect(sessionListErrorResponse(error)?.status).toBe(503)
    expect(listSessionPage).not.toHaveBeenCalled()
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
      settled: "active",
      ownership: "all",
      seen: "all",
      limit: 2,
      after: { updatedAt: 2, createdAt: 1, lastHumanTurnAt: 9, sessionRef: "workspace:ws_1:session:ses_a" },
    })
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
