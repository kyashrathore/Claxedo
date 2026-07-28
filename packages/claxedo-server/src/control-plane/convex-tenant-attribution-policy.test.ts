import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { record } from "../../../../convex/auditEvents"
import { requireControlPlaneService } from "../../../../convex/model"
import { createCloud } from "../../../../convex/workspaces"
import { timingSafeEqualStrings } from "./web-crypto"

/**
 * Pre-launch security review §4.1 and §4.4 — cross-tenant WRITE attribution.
 *
 * Both mutations exercised here take a caller-supplied public `workspace_id`,
 * and both are `authedMutation`s, which means they are reachable directly
 * through the public Convex SDK using the deployment URL that ships in the app
 * bundle as `VITE_CONVEX_URL`. Hardening the Worker HTTP routes in front of
 * them does not close either hole — these tests call the Convex handlers
 * directly for exactly that reason.
 *
 * Public workspace ids are `ws_${Date.now().toString(36)}`: a bare millisecond
 * timestamp with no random component, so "attacker guesses a victim's id" is
 * the assumed starting position throughout, not a stretch.
 */

type Row = Record<string, unknown> & { _id: string }

function db(seed: Record<string, Row[]>) {
  const rows = Object.fromEntries(Object.entries(seed).map(([key, value]) => [key, [...value]]))
  return {
    rows,
    query(table: string) {
      const filters: Array<[string, unknown]> = []
      const query = {
        withIndex(_name: string, build: (q: { eq: (key: string, value: unknown) => unknown }) => unknown) {
          build({
            eq(key, value) {
              filters.push([key, value])
              return this
            },
          })
          return query
        },
        async collect() {
          return (rows[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value))
        },
        async unique() {
          return (await query.collect())[0] ?? null
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

const VICTIM_CLOUD_WORKSPACE: Row = {
  _id: "workspace_victim",
  workspace_id: "ws_victim",
  owner_user_id: "user_victim",
  org_id: "org_victim",
  backing: "cloud-vm",
  access: "cloud",
  display_name: "victim cloud workspace",
  repo_url: "https://github.com/victim/private.git",
  created_at: 1,
  updated_at: 1,
}

/** The calling identity is always `user_caller`; the fixture decides what it can reach. */
function ctx(overrides: Partial<Record<string, Row[]>> = {}) {
  return {
    db: db({
      users: [
        { _id: "user_caller", token_identifier: "token_caller", created_at: 1, updated_at: 1 },
        { _id: "user_victim", token_identifier: "token_victim", created_at: 1, updated_at: 1 },
      ],
      orgs: [{ _id: "org_victim", owner_user_id: "user_victim", created_at: 1, updated_at: 1 }],
      workspaces: [VICTIM_CLOUD_WORKSPACE],
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

function handler(fn: unknown) {
  return (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler
}

const adminShareGrant: Row = {
  _id: "grant_1",
  workspace_id: "workspace_victim",
  granted_to_user_id: "user_caller",
  role: "admin",
  created_at: 1,
}

describe("workspaces.createCloud existing-row guard (§4.1)", () => {
  test("a guessed id belonging to another tenant is refused and inserts nothing", async () => {
    const input = ctx()

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_victim",
      display_name: "hijacked",
      repo_url: "https://github.com/attacker/evil.git",
    })).rejects.toThrow("Workspace not found")

    // The decisive assertion: no SECOND row carrying the victim's public id.
    // Two rows sharing one `workspace_id` permanently bricks the workspace for
    // everybody, because every lookup goes through `workspaceByPublicId` and
    // its `.unique()` throws the moment the id is ambiguous.
    expect(input.db.rows.workspaces).toHaveLength(1)
    expect(input.db.rows.workspaces[0]).toMatchObject({
      owner_user_id: "user_victim",
      display_name: "victim cloud workspace",
      repo_url: "https://github.com/victim/private.git",
      updated_at: 1,
    })
  })

  test("an admin SHARE grant does not authorize writing through the create path", async () => {
    // Proves the guard is ownership-based, not merely `authorizeWorkspace`:
    // this caller genuinely holds workspace-admin via a legitimate share.
    const input = ctx({ workspace_share_grants: [adminShareGrant] })

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_victim",
      display_name: "hijacked",
    })).rejects.toThrow("Workspace not found")
    expect(input.db.rows.workspaces).toHaveLength(1)
  })

  test("the owner re-creating their own cloud workspace is an idempotent no-op", async () => {
    // The create-retry path: the caller reuses an id it already owns. It must
    // neither duplicate the row nor patch it from the retry's arguments.
    const input = ctx({
      users: [{ _id: "user_caller", token_identifier: "token_caller", created_at: 1, updated_at: 1 }],
      workspaces: [{ ...VICTIM_CLOUD_WORKSPACE, owner_user_id: "user_caller" }],
    })

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_victim",
      display_name: "renamed by retry",
    })).resolves.toEqual({ workspace_doc_id: "workspace_victim" })

    expect(input.db.rows.workspaces).toHaveLength(1)
    expect(input.db.rows.workspaces[0]).toMatchObject({
      display_name: "victim cloud workspace",
      updated_at: 1,
    })
  })

  test("the owner cannot flip their own user-hosted workspace to cloud", async () => {
    const input = ctx({
      users: [{ _id: "user_caller", token_identifier: "token_caller", created_at: 1, updated_at: 1 }],
      workspaces: [{
        ...VICTIM_CLOUD_WORKSPACE,
        owner_user_id: "user_caller",
        backing: "local-worktree",
        access: "user-hosted",
      }],
    })

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_victim",
      display_name: "now cloud",
    })).rejects.toThrow("workspace_backing_conflict")
    expect(input.db.rows.workspaces[0]).toMatchObject({
      backing: "local-worktree",
      access: "user-hosted",
      updated_at: 1,
    })
  })

  test("a soft-deleted id is not recycled, even by its own owner", async () => {
    const input = ctx({
      users: [{ _id: "user_caller", token_identifier: "token_caller", created_at: 1, updated_at: 1 }],
      workspaces: [{ ...VICTIM_CLOUD_WORKSPACE, owner_user_id: "user_caller", deleted_at: 5 }],
    })

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_victim",
      display_name: "resurrected",
    })).rejects.toThrow("Workspace not found")
    expect(input.db.rows.workspaces).toHaveLength(1)
  })

  test("an unused id still creates normally", async () => {
    const input = ctx()

    await expect(handler(createCloud)(input, {
      workspace_id: "ws_fresh",
      display_name: "mine",
    })).resolves.toMatchObject({ workspace_doc_id: expect.stringContaining("workspaces:") })

    const created = input.db.rows.workspaces.find((row) => row.workspace_id === "ws_fresh")!
    expect(created).toMatchObject({
      owner_user_id: "user_caller",
      backing: "cloud-vm",
      access: "cloud",
      display_name: "mine",
    })
  })
})

describe("auditEvents.record workspace attribution (§4.4)", () => {
  test("a workspace the caller cannot read is never attributed", async () => {
    const input = ctx()

    await handler(record)(input, {
      action: "credentials.export",
      result: "allow",
      reason: "forged",
      workspace_id: "ws_victim",
      metadata: { note: "attacker supplied" },
    })

    const [event] = input.db.rows.audit_events
    // `audit_events` is indexed `by_workspace_created`, so an unset
    // `workspace_id` is precisely what keeps this row out of the victim's log.
    expect(event!.workspace_id).toBeUndefined()
    expect(event!.user_id).toBe("user_caller")
    expect(event!.metadata).toEqual({
      note: "attacker supplied",
      unattributed_workspace_id: "ws_victim",
    })
  })

  test("a workspace the caller can read is attributed as before", async () => {
    const input = ctx({
      workspace_memberships: [{
        _id: "membership_1",
        workspace_id: "workspace_victim",
        user_id: "user_caller",
        role: "viewer",
      }],
    })

    await handler(record)(input, {
      action: "workspaces.open",
      result: "allow",
      workspace_id: "ws_victim",
      metadata: { host: "edge" },
    })

    expect(input.db.rows.audit_events[0]).toMatchObject({
      user_id: "user_caller",
      workspace_id: "workspace_victim",
      action: "workspaces.open",
      metadata: { host: "edge" },
    })
  })

  test("the denied-access audit write still succeeds — it must never throw", async () => {
    // Regression pin for the shape of the fix, not just its effect. The literal
    // `throw` the review proposed breaks `workspaceOpenAuthorizationError`
    // (src/routes/workspace-runtime-token-guards.ts), which records
    // `workspaces.open.denied` for a workspace whose authorization JUST failed
    // and awaits the write with no catch: a throw turns a clean 403 into a 500
    // and loses the denial. An audit write embedded in a request guard has to
    // be total.
    const input = ctx()

    await expect(handler(record)(input, {
      action: "workspaces.open.denied",
      result: "deny",
      reason: "workspace_authorization_denied",
      workspace_id: "ws_victim",
    })).resolves.toBeDefined()

    expect(input.db.rows.audit_events[0]).toMatchObject({
      user_id: "user_caller",
      result: "deny",
      reason: "workspace_authorization_denied",
      metadata: { unattributed_workspace_id: "ws_victim" },
    })
    expect(input.db.rows.audit_events[0]!.workspace_id).toBeUndefined()
  })

  test("an unresolvable id is indistinguishable from an unauthorized one (no enumeration oracle)", async () => {
    const unauthorized = ctx()
    const missing = ctx()

    await handler(record)(unauthorized, { action: "probe", result: "deny", workspace_id: "ws_victim" })
    await handler(record)(missing, { action: "probe", result: "deny", workspace_id: "ws_does_not_exist" })

    // Same outcome (success) and same row shape either way: the caller learns
    // nothing about whether the id exists. Rejecting only the unauthorized case
    // would have turned this mutation into an id oracle.
    for (const input of [unauthorized, missing]) {
      expect(input.db.rows.audit_events).toHaveLength(1)
      expect(input.db.rows.audit_events[0]!.workspace_id).toBeUndefined()
    }
    expect(unauthorized.db.rows.audit_events[0]!.metadata)
      .toEqual({ unattributed_workspace_id: "ws_victim" })
    expect(missing.db.rows.audit_events[0]!.metadata)
      .toEqual({ unattributed_workspace_id: "ws_does_not_exist" })
  })

  test("an event with no workspace_id is unchanged", async () => {
    const input = ctx()

    await handler(record)(input, { action: "session.start", result: "allow", metadata: { a: 1 } })

    expect(input.db.rows.audit_events[0]).toMatchObject({ metadata: { a: 1 } })
    expect(input.db.rows.audit_events[0]!.workspace_id).toBeUndefined()
  })
})

describe("convex timingSafeEqual matches the server implementation", () => {
  const CURRENT = "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN"
  afterEach(() => delete process.env[CURRENT])

  const accepts = (token: string) => {
    try {
      requireControlPlaneService(token)
      return true
    } catch {
      return false
    }
  }

  test("no modulo-wraparound: the loop shape mirrors web-crypto.ts", () => {
    // Behaviour-preserving normalization, so only a source assertion can fail
    // without the fix. The point is drift: `convex/model.ts` cannot import from
    // packages/claxedo-server, so the two copies are kept aligned by review,
    // and `i % b.length` was a gratuitously different shape with a latent
    // `i % 0` NaN on an empty expected value.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../../../../convex/model.ts"),
      "utf8",
    )
    const body = source.slice(source.indexOf("function timingSafeEqual("))
    const loop = body.slice(0, body.indexOf("return diff === 0"))
    expect(loop).not.toMatch(/%\s*b\.length/)
    expect(loop).toMatch(/Math\.max\(a\.length,\s*b\.length\)/)
  })

  test("agrees with timingSafeEqualStrings across the edge cases", () => {
    const secret = "token-current"
    process.env[CURRENT] = secret
    for (
      const candidate of [
        secret,
        "",
        "t",
        "token-curren",
        "token-currentt",
        "token-currenT",
        "\0".repeat(secret.length),
        "tokentokentok",
      ]
    ) {
      expect(accepts(candidate)).toBe(timingSafeEqualStrings(candidate, secret))
    }
  })
})
