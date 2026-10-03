import { describe, expect, test } from "vitest"
import { buildSessionListResponse, encodeSessionListAfter, parseSessionListQuery } from "./navigation-list"

describe("session list owner mapping", () => {
  test("invalid cursors expose a typed client refusal", () => {
    try {
      parseSessionListQuery(new URL("http://test.local/session-list?scope=workspace&workspaceId=ws_1&after=invalid"))
      throw new Error("expected validation to fail")
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_session_list_cursor", status: 400, retryable: false })
    }
  })
  test("maps owner_* fields onto navigation rows for rail favicons", () => {
    const query = parseSessionListQuery(new URL("http://test.local/session-list?scope=workspace&workspaceId=ws_1&limit=20"))
    const response = buildSessionListResponse({
      query,
      sessions: [{
        session_id: "ses_shared",
        workspace_id: "ws_1",
        title: "Shared with Bob",
        created_at: 10,
        updated_at: 20,
        owner_name: "Alice",
        owner_avatar_url: "https://example.test/alice.png",
        owner_public_id: "usr_alice",
      }],
    })
    expect(response.items?.[0]).toMatchObject({
      sessionId: "ses_shared",
      owner: {
        name: "Alice",
        avatarUrl: "https://example.test/alice.png",
        publicId: "usr_alice",
      },
    })
  })
})

describe("human_turn_desc", () => {
  const session = (input: { id: string; created: number; updated: number; humanTurn?: number }) => ({
    session_id: input.id,
    workspace_id: "ws_1",
    title: input.id,
    created_at: input.created,
    updated_at: input.updated,
    ...(input.humanTurn !== undefined ? { last_human_turn_at: input.humanTurn } : {}),
  })
  const query = (limit: number, extra = "") =>
    parseSessionListQuery(new URL(
      `http://test.local/session-list?scope=workspace&workspaceId=ws_1&sort=human_turn_desc&limit=${limit}${extra}`,
    ))

  test("orders by the reader's last turn, then creation, with the never-prompted last", () => {
    const response = buildSessionListResponse({
      query: query(10),
      sessions: [
        session({ id: "quiet-old", created: 100, updated: 9_000 }),
        session({ id: "spoken-early", created: 3_000, updated: 9_000, humanTurn: 4_000 }),
        session({ id: "quiet-new", created: 800, updated: 150 }),
        session({ id: "spoken-late", created: 2_000, updated: 200, humanTurn: 6_000 }),
      ],
    })
    expect(response.items?.map((row) => row.sessionId))
      .toEqual(["spoken-late", "spoken-early", "quiet-new", "quiet-old"])
  })

  test("the cursor resumes across the boundary into the never-prompted rows", () => {
    const sessions = [
      session({ id: "spoken-2", created: 100, updated: 100, humanTurn: 2_000 }),
      session({ id: "spoken-1", created: 200, updated: 200, humanTurn: 1_000 }),
      session({ id: "quiet-new", created: 900, updated: 900 }),
      session({ id: "quiet-old", created: 400, updated: 400 }),
    ]
    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = buildSessionListResponse({
        query: query(2, cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        sessions,
      })
      seen.push(...(page.items ?? []).map((row) => row.sessionId))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(["spoken-2", "spoken-1", "quiet-new", "quiet-old"])
  })
})

describe("the after key", () => {
  const row = (sessionId: string, workspaceId: string, created: number, humanTurn?: number) => ({
    session_id: sessionId,
    workspace_id: workspaceId,
    project_id: "prj_1",
    created_at: created,
    updated_at: created,
    ...(humanTurn === undefined ? {} : { last_human_turn_at: humanTurn }),
  })
  const query = (limit: number, after?: string) =>
    parseSessionListQuery(new URL(
      `http://test.local/session-list?scope=project&projectId=prj_1&sort=human_turn_desc&limit=${limit}${after ? `&after=${after}` : ""}`,
    ))

  test("round-trips an order key, and refuses one sent with a cursor or malformed", () => {
    const key = { updatedAt: 5, createdAt: 4, lastHumanTurnAt: 9, sessionRef: "workspace:ws_1:session:ses_1" }
    expect(query(5, encodeSessionListAfter(key)).after).toEqual(key)
    const unprompted = { updatedAt: 5, createdAt: 4, sessionRef: "workspace:ws_1:session:ses_2" }
    expect(query(5, encodeSessionListAfter(unprompted)).after).toEqual(unprompted)
    expect(() => parseSessionListQuery(new URL(`http://test.local/?after=${encodeSessionListAfter(key)}&cursor=x`)))
      .toThrow("invalid_session_list_cursor")
    expect(() => query(5, "not-a-key")).toThrow("invalid_session_list_cursor")
  })

  test("two stores walked with one shared key give their union in order, with nothing skipped or repeated", () => {
    const local = [row("l1", "ws_local", 10, 90), row("l2", "ws_local", 20), row("l3", "ws_local", 30), row("l4", "ws_local", 40)]
    const cloud = [row("c1", "ws_cloud", 15, 95), row("c2", "ws_cloud", 25), row("c3", "ws_cloud", 35)]
    const readStore = (store: typeof local, after?: string) => buildSessionListResponse({ query: query(2, after), sessions: store })
    const walked: string[] = []
    let after: string | undefined
    for (let pages = 0; pages < 10; pages++) {
      const pagesRead = [readStore(local, after), readStore(cloud, after)]
      const merged = buildSessionListResponse({ query: query(2), sessions: pagesRead.flatMap((page) => page.items ?? []).map((item) => ({
        session_id: item.sessionId,
        workspace_id: item.workspaceId,
        project_id: item.projectId,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        ...(item.lastHumanTurnAt === undefined ? {} : { last_human_turn_at: item.lastHumanTurnAt }),
      })) })
      walked.push(...(merged.items ?? []).map((item) => item.sessionId))
      const more = pagesRead.some((page) => page.nextAfter) || (merged.items?.length ?? 0) < pagesRead.reduce((sum, page) => sum + (page.items?.length ?? 0), 0)
      const last = merged.items?.at(-1)
      if (!more || !last) break
      after = encodeSessionListAfter(last)
    }
    expect(walked).toEqual(["c1", "l1", "l4", "c3", "l3", "c2", "l2"])
  })
})
