import { describe, expect, test } from "bun:test"
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
