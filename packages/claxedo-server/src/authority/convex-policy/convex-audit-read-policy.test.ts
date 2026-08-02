import { describe, expect, test } from "vitest"
import { listForOrg, listForWorkspace, listMine, record } from "../../../../../convex/auditEvents"

/**
 * Pre-launch security review §6.11 — the `audit_events` READ path.
 *
 * The write side already refuses to file a row under a workspace the caller
 * cannot read, parking the attempted id under a reserved `metadata` key
 * instead. These tests pin the other half: that reading the table cannot
 * re-open the same cross-tenant hole from the opposite direction, and that the
 * unverified attempted id is never laundered back into attribution.
 *
 * Handlers are exercised directly, not through a route, because every one of
 * these is an `authedQuery` and therefore reachable via the public Convex SDK
 * with the deployment URL that ships in the app bundle as `VITE_CONVEX_URL`.
 */

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
  return {
    rows,
    query(table: string) {
      const equals: Array<[string, unknown]> = []
      const lessThan: Array<[string, unknown]> = []
      let descending = false
      const matching = () =>
        (rows[table] ?? [])
          .filter((row) => equals.every(([key, value]) => row[key] === value))
          .filter((row) => lessThan.every(([key, value]) => (row[key] as number) < (value as number)))
          .sort((left, right) => {
            const delta = (left.created_at as number ?? 0) - (right.created_at as number ?? 0)
            return descending ? -delta : delta
          })
      const query = {
        withIndex(_name: string, build: (q: unknown) => unknown) {
          const builder = {
            eq(key: string, value: unknown) {
              equals.push([key, value])
              return builder
            },
            lt(key: string, value: unknown) {
              lessThan.push([key, value])
              return builder
            },
          }
          build(builder)
          return query
        },
        order(direction: "asc" | "desc") {
          descending = direction === "desc"
          return query
        },
        async take(limit: number) {
          return matching().slice(0, limit)
        },
        async collect() {
          return matching()
        },
        async unique() {
          return matching()[0] ?? null
        },
      }
      return query
    },
    async insert(table: string, row: Record<string, unknown>) {
      const id = `${table}:${(rows[table] ?? []).length + 1}`
      rows[table] ??= []
      rows[table].push({ _id: id, ...row })
      return id
    },
    async get(id: string) {
      return Object.values(rows).flat().find((row) => row._id === id) ?? null
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const table of Object.keys(rows)) {
        const index = rows[table]!.findIndex((row) => row._id === id)
        if (index === -1) continue
        rows[table]![index] = { ...rows[table]![index], ...patch }
        return
      }
      throw new Error(`Missing row ${id}`)
    },
  }
}

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

function auditRow(input: Partial<Row> & { _id: string }): Row {
  return {
    action: "workspaces.open",
    result: "allow",
    created_at: 100,
    ...input,
  }
}

/** `user_caller` is always the identity; the fixture decides what it can reach. */
function ctx(overrides: Partial<Record<string, Row[]>> = {}) {
  return {
    db: db({
      users: [
        { _id: "user_caller", token_identifier: "token_caller", created_at: 1, updated_at: 1 },
        { _id: "user_victim", token_identifier: "token_victim", created_at: 1, updated_at: 1 },
      ],
      orgs: [
        { _id: "org_victim", name: "victim", owner_user_id: "user_victim", created_at: 1, updated_at: 1 },
        { _id: "org_caller", name: "caller", owner_user_id: "user_caller", created_at: 1, updated_at: 1 },
      ],
      workspaces: [
        {
          _id: "workspace_victim",
          workspace_id: "ws_victim",
          owner_user_id: "user_victim",
          org_id: "org_victim",
          display_name: "victim",
          created_at: 1,
          updated_at: 1,
        },
        {
          _id: "workspace_caller",
          workspace_id: "ws_caller",
          owner_user_id: "user_caller",
          org_id: "org_caller",
          display_name: "caller",
          created_at: 1,
          updated_at: 1,
        },
      ],
      projects: [],
      project_memberships: [],
      workspace_memberships: [],
      workspace_share_grants: [],
      org_memberships: [],
      audit_events: [],
      ...overrides,
    }),
    auth: {
      getUserIdentity: async () => ({ tokenIdentifier: "token_caller" }),
    },
  }
}

const VICTIM_ROW = auditRow({
  _id: "audit_victim",
  user_id: "user_victim",
  workspace_id: "workspace_victim",
  action: "workspaces.open",
  reason: "victim private reason",
  created_at: 300,
})

describe("auditEvents.listForWorkspace (§6.11)", () => {
  test("another tenant's audit history is refused, and refused the same way a missing id is", async () => {
    const input = ctx({ audit_events: [VICTIM_ROW] })

    // Identical message for "no such workspace" and "not yours": distinguishing
    // them would turn the reader into the id-enumeration oracle the WRITE path
    // deliberately avoided becoming.
    await expect(handler(listForWorkspace)(input, { workspace_id: "ws_victim" }))
      .rejects.toThrow("Workspace not found")
    await expect(handler(listForWorkspace)(input, { workspace_id: "ws_does_not_exist" }))
      .rejects.toThrow("Workspace not found")
  })

  test("read access is not enough — the bar is workspace admin", async () => {
    // A viewer can legitimately open the workspace. Audit history is the record
    // of what every OTHER member did in it, so it sits at the admin bar.
    const input = ctx({
      audit_events: [VICTIM_ROW],
      workspace_share_grants: [{
        _id: "grant_viewer",
        workspace_id: "workspace_victim",
        granted_to_user_id: "user_caller",
        role: "viewer",
        created_at: 1,
      }],
    })

    await expect(handler(listForWorkspace)(input, { workspace_id: "ws_victim" }))
      .rejects.toThrow("Workspace not found")
  })

  test("an admin share sees that workspace's rows, and only that workspace's", async () => {
    const input = ctx({
      audit_events: [
        VICTIM_ROW,
        auditRow({ _id: "audit_other", user_id: "user_caller", workspace_id: "workspace_caller" }),
        // Unattributed: belongs to its author, never to a workspace view.
        auditRow({
          _id: "audit_unattributed",
          user_id: "user_caller",
          metadata: { unattributed_workspace_id: "ws_victim" },
        }),
      ],
      workspace_share_grants: [{
        _id: "grant_admin",
        workspace_id: "workspace_victim",
        granted_to_user_id: "user_caller",
        role: "admin",
        created_at: 1,
      }],
    })

    const rows = await handler(listForWorkspace)(input, { workspace_id: "ws_victim" }) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(["audit_victim"])
    expect(rows[0]).toMatchObject({ workspace_id: "ws_victim", reason: "victim private reason" })
  })

  test("a forged attribution claim in metadata is never surfaced as attribution", async () => {
    // The caller owns `ws_caller` and can write whatever metadata it likes.
    // Planting the reserved key must not make the row look like a real
    // attempted-attribution record to any reader.
    const input = ctx({
      audit_events: [auditRow({
        _id: "audit_forged",
        user_id: "user_caller",
        workspace_id: "workspace_caller",
        metadata: { unattributed_workspace_id: "ws_victim", note: "kept" },
      })],
    })

    const rows = await handler(listForWorkspace)(input, { workspace_id: "ws_caller" }) as Array<Record<string, unknown>>
    expect(rows[0]!.unverified_attempted_workspace_id).toBeUndefined()
    expect(rows[0]!.metadata).toEqual({ note: "kept" })
  })

  test("newest first, and the limit is clamped rather than trusted", async () => {
    const input = ctx({
      audit_events: [
        auditRow({ _id: "audit_old", user_id: "user_caller", workspace_id: "workspace_caller", created_at: 1 }),
        auditRow({ _id: "audit_new", user_id: "user_caller", workspace_id: "workspace_caller", created_at: 9 }),
      ],
    })

    const rows = await handler(listForWorkspace)(input, {
      workspace_id: "ws_caller",
      limit: 100_000,
    }) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(["audit_new", "audit_old"])

    const page = await handler(listForWorkspace)(input, {
      workspace_id: "ws_caller",
      limit: 1,
      before: 9,
    }) as Array<Record<string, unknown>>
    expect(page.map((row) => row.id)).toEqual(["audit_old"])
  })
})

describe("auditEvents.listMine — the only reader of unattributed rows (§6.11)", () => {
  test("an unattributed row reaches its author, with the claim labelled unverified", async () => {
    // Written exactly the way the guarded write path writes one.
    const writeCtx = ctx()
    await handler(record)(writeCtx, {
      action: "workspaces.open.denied",
      result: "deny",
      workspace_id: "ws_victim",
      metadata: { attempt: 1 },
    })
    const written = writeCtx.db.rows.audit_events![0]!
    expect(written.workspace_id).toBeUndefined()

    const rows = await handler(listMine)(writeCtx, {}) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      unverified_attempted_workspace_id: "ws_victim",
      // Not `workspace_id`: the reader must never present an unverified claim
      // in the field a UI would treat as real attribution.
      workspace_id: undefined,
      metadata: { attempt: 1 },
    })
  })

  test("it returns only the caller's own rows", async () => {
    const input = ctx({
      audit_events: [
        VICTIM_ROW,
        auditRow({ _id: "audit_victim_unattributed", user_id: "user_victim", metadata: { secret: true } }),
        auditRow({ _id: "audit_mine", user_id: "user_caller", workspace_id: "workspace_caller" }),
      ],
    })

    const rows = await handler(listMine)(input, {}) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(["audit_mine"])
    expect(rows[0]!.workspace_id).toBe("ws_caller")
  })
})

describe("auditEvents.listForOrg — org authority, not a workspace share (§6.11 / §4.2)", () => {
  test("a workspace admin SHARE does not become an org-wide export", async () => {
    // The §4.2 escalation chain in reverse: an outsider handed admin over one
    // workspace passes `authorizeWorkspace(..., "admin")` with no org
    // membership at all. An org-wide read must not accept that.
    const input = ctx({
      audit_events: [VICTIM_ROW],
      workspace_share_grants: [{
        _id: "grant_admin",
        workspace_id: "workspace_victim",
        granted_to_user_id: "user_caller",
        role: "admin",
        created_at: 1,
      }],
    })

    await expect(handler(listForOrg)(input, { org_id: "org_victim" }))
      .rejects.toThrow("Organization not found")
  })

  test("a plain org member is refused; an org admin gets that org's rows only", async () => {
    const member = ctx({
      audit_events: [VICTIM_ROW],
      org_memberships: [{ _id: "membership_1", org_id: "org_victim", user_id: "user_caller", role: "member" }],
    })
    await expect(handler(listForOrg)(member, { org_id: "org_victim" }))
      .rejects.toThrow("Organization not found")

    const admin = ctx({
      audit_events: [
        VICTIM_ROW,
        auditRow({ _id: "audit_other_org", user_id: "user_caller", workspace_id: "workspace_caller" }),
        // Unattributed rows carry no verified org linkage, so they are absent
        // from an org export by construction — including this caller's own.
        auditRow({ _id: "audit_unattributed", user_id: "user_caller", metadata: { unattributed_workspace_id: "x" } }),
      ],
      org_memberships: [{ _id: "membership_1", org_id: "org_victim", user_id: "user_caller", role: "admin" }],
    })

    const rows = await handler(listForOrg)(admin, { org_id: "org_victim" }) as Array<Record<string, unknown>>
    expect(rows.map((row) => row.id)).toEqual(["audit_victim"])
  })

  test("a deleted org exports nothing", async () => {
    const input = ctx({
      orgs: [
        { _id: "org_victim", name: "victim", owner_user_id: "user_caller", deleted_at: 5, created_at: 1, updated_at: 1 },
      ],
      audit_events: [VICTIM_ROW],
    })

    await expect(handler(listForOrg)(input, { org_id: "org_victim" }))
      .rejects.toThrow("Organization not found")
  })
})
