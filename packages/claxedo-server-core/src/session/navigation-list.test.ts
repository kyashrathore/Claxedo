import { describe, expect, test } from "vitest"
import { buildSessionListResponse, parseSessionListQuery } from "./navigation-list"

describe("session list owner mapping", () => {
  test("maps owner_* fields onto navigation rows for rail favicons", () => {
    const query = parseSessionListQuery(new URL("http://test.local/session-list?scope=workspace&workspaceId=ws_1&groupBy=none&limit=20"))
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
      `http://test.local/session-list?scope=workspace&workspaceId=ws_1&groupBy=none&sort=human_turn_desc&limit=${limit}${extra}`,
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
