import { describe, expect, test } from "vitest"
import { readNotifications } from "../../../../convex/workgraphNotifications"

describe("Convex WorkGraph notifications", () => {
  test("uses bounded indexed Convex pagination and forwards its opaque cursor", async () => {
    const db = new NotificationDb([
      notification("notification_3", 30),
      notification("notification_2", 20),
      notification("notification_1", 10),
    ])

    const first = await readNotifications({ db } as never, "org-a" as never, "user-a" as never, {
      kind: "list",
      state: "unread",
      limit: 2,
    })
    const cursor = "wgnc1:org-a:user-a:unread:convex-cursor%3A2"
    expect(first).toMatchObject({
      notifications: [{ id: "notification_3" }, { id: "notification_2" }],
      hasMore: true,
      nextCursor: cursor,
    })
    expect(db.requests[0]).toEqual({ index: "by_tenant_state_created", order: "desc", cursor: null, numItems: 2 })

    const second = await readNotifications({ db } as never, "org-a" as never, "user-a" as never, {
      kind: "list",
      state: "unread",
      limit: 2,
      after: cursor,
    })
    expect(second).toMatchObject({ notifications: [{ id: "notification_1" }], hasMore: false })
    expect(second).not.toHaveProperty("nextCursor")
    expect(db.requests[1]).toEqual({
      index: "by_tenant_state_created",
      order: "desc",
      cursor: "convex-cursor:2",
      numItems: 2,
    })
    await expect(readNotifications({ db } as never, "org-b" as never, "user-a" as never, {
      kind: "list",
      state: "unread",
      limit: 2,
      after: cursor,
    })).rejects.toMatchObject({ data: { code: "cursor_invalid", reason: "owner_mismatch" } })
    await expect(readNotifications({ db } as never, "org-a" as never, "user-a" as never, {
      kind: "list",
      state: "read",
      limit: 2,
      after: cursor,
    })).rejects.toMatchObject({ data: { code: "cursor_invalid", reason: "filter_mismatch" } })
    await expect(readNotifications({ db } as never, "org-a" as never, "user-a" as never, {
      kind: "list",
      state: "unread",
      limit: 2,
      after: "malformed",
    })).rejects.toMatchObject({ data: { code: "cursor_invalid", reason: "invalid" } })
  })
})

function notification(id: string, createdAt: number) {
  return {
    organization_id: "org-a",
    _id: `row-${id}`,
    owner_user_id: "user-a",
    id,
    notification_kind: "actionable_recap",
    state: "unread",
    stream_id: "stream-a",
    recap_id: `recap-${id}`,
    row_version: 1,
    schema_version: 1,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

class NotificationDb {
  readonly requests: Array<Record<string, unknown>> = []

  private readonly recaps

  constructor(private readonly rows: Array<ReturnType<typeof notification>>) {
    this.recaps = rows.map((row) => ({
      organization_id: row.organization_id,
      owner_user_id: row.owner_user_id,
      id: row.recap_id,
      generation: { state: "succeeded", method: "agent_session", sessionId: `session-${row.recap_id}` },
    }))
  }

  query(table: string) {
    let selected: Array<Record<string, any>> = [
      ...(table === "workgraph_recaps"
        ? this.recaps
        : table === "workgraph_notifications"
          ? this.rows
          : []),
    ]
    let index = ""
    let order = ""
    const chain = {
      withIndex: (name: string, build: (query: { eq(field: string, value: unknown): unknown }) => unknown) => {
        index = name
        const filters: Array<[string, unknown]> = []
        const query = {
          eq(field: string, value: unknown) {
            filters.push([field, value])
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => filters.every(([field, value]) => row[field as keyof typeof row] === value))
        return chain
      },
      order: (value: string) => {
        order = value
        selected.sort((left, right) => right.created_at - left.created_at)
        return chain
      },
      filter: (build: (query: { field(field: string): string; eq(field: string, value: unknown): (row: Record<string, unknown>) => boolean }) => (row: Record<string, unknown>) => boolean) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] === value,
        }
        selected = selected.filter(build(query))
        return chain
      },
      paginate: async (options: { cursor: string | null; numItems: number }) => {
        this.requests.push({ index, order, ...options })
        const offset = options.cursor ? Number(options.cursor.split(":").at(-1)) : 0
        const page = selected.slice(offset, offset + options.numItems)
        const next = offset + page.length
        return {
          page,
          isDone: next >= selected.length,
          continueCursor: `convex-cursor:${next}`,
        }
      },
      unique: async () => selected[0] ?? null,
    }
    return chain
  }
}
