import { afterEach, beforeEach, describe, expect, test } from "vitest"
import schema from "../../../../convex/schema"
import {
  appendRevisionForService,
  createForService,
  findForService,
  getHeadRevisionForService,
  getRevisionForService,
  listForService,
} from "../../../../convex/docs"

const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "service-secret"
})
afterEach(() => {
  if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
})

describe("Convex Docs v2 policy", () => {
  test("defines tenant-indexed documents and append-only revisions", () => {
    expect(schema.tables.documents.validator.fields).toMatchObject({
      organization_id: { isOptional: "required", kind: "id", tableName: "orgs" },
      project_id: { isOptional: "required", kind: "string" },
      head_revision_id: { isOptional: "required", kind: "string" },
    })
    expect((schema.tables.documents as unknown as { indexes: Array<{ fields: string[] }> }).indexes).toContainEqual(
      expect.objectContaining({ fields: ["organization_id", "project_id", "document_id"] }),
    )
    expect(
      (schema.tables.document_revisions as unknown as { indexes: Array<{ fields: string[] }> }).indexes,
    ).toContainEqual(expect.objectContaining({ fields: ["document_id", "revision_number"] }))
  })

  test("creates a revision chain atomically, preserves old content, and rejects a stale parent", async () => {
    const db = fixture()
    const created = await invoke(createForService, db, content())
    expect(created).toMatchObject({ ok: true, revision: { revisionNumber: 1, markdown: "# Launch" } })

    const revised = await invoke(appendRevisionForService, db, {
      ...content({
        revision_id: "document_revision_2",
        markdown: "# Launch\n\nReady.",
        content_hash: await digest("# Launch\n\nReady."),
        authored_at: 20,
      }),
      expected_parent_revision_id: "document_revision_1",
    })
    expect(revised).toMatchObject({
      ok: true,
      revision: {
        revisionNumber: 2,
        parentRevisionId: "document_revision_1",
        markdown: "# Launch\n\nReady.",
      },
    })

    await expect(invoke(listForService, db, { ...scope(), project_id: "project_1" })).resolves.toEqual({
      ok: true,
      documents: [
        {
          documentId: "document_1",
          projectId: "project_1",
          title: "Launch",
          headRevisionId: "document_revision_2",
          createdAt: 10,
          updatedAt: 20,
        },
      ],
    })
    await expect(
      invoke(getHeadRevisionForService, db, {
        ...scope(),
        project_id: "project_1",
        document_id: "document_1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      revision: { revisionId: "document_revision_2", revisionNumber: 2, markdown: "# Launch\n\nReady." },
    })

    await expect(
      invoke(getRevisionForService, db, {
        ...scope(),
        project_id: "project_1",
        document_id: "document_1",
        revision_id: "document_revision_1",
      }),
    ).resolves.toMatchObject({ ok: true, revision: { revisionNumber: 1, markdown: "# Launch" } })

    const stale = await invoke(appendRevisionForService, db, {
      ...content({ revision_id: "document_revision_orphan" }),
      expected_parent_revision_id: "document_revision_1",
    })
    expect(stale).toEqual({
      ok: false,
      code: "document_revision_conflict",
      message: "Document head changed",
      currentRevisionId: "document_revision_2",
    })
    expect(db.rows.document_revisions).toHaveLength(2)
  })

  test("keeps document existence invisible across organizations and projects", async () => {
    const db = fixture()
    await invoke(createForService, db, content())

    await expect(
      invoke(findForService, db, {
        ...scope({ organization_id: "org-b", user: user("b") }),
        document_id: "document_1",
      }),
    ).resolves.toEqual({ ok: true, document: null })
    await expect(
      invoke(getRevisionForService, db, {
        ...scope({ organization_id: "org-b", user: user("b") }),
        project_id: "project_2",
        document_id: "document_1",
        revision_id: "document_revision_1",
      }),
    ).resolves.toMatchObject({ ok: false, code: "document_not_found" })
    await expect(
      invoke(listForService, db, {
        ...scope({ organization_id: "org-b", user: user("b") }),
        project_id: "project_1",
      }),
    ).resolves.toMatchObject({ ok: false, code: "document_not_found" })
    await expect(
      invoke(getHeadRevisionForService, db, {
        ...scope({ organization_id: "org-b", user: user("b") }),
        project_id: "project_2",
        document_id: "document_1",
      }),
    ).resolves.toMatchObject({ ok: false, code: "document_not_found" })
  })

  test("validates SHA-256 before writing any document state", async () => {
    const db = fixture()
    const response = await invoke(createForService, db, content({ content_hash: "0".repeat(64) }))
    expect(response).toMatchObject({ ok: false, code: "document_content_hash_mismatch" })
    expect(db.rows.documents).toEqual([])
    expect(db.rows.document_revisions).toEqual([])
  })
})

function user(suffix: string) {
  return {
    token_identifier: `token-${suffix}`,
    subject: `user-${suffix}`,
    issuer: "https://clerk.test",
  }
}

function scope(overrides: Record<string, unknown> = {}) {
  return { user: user("a"), organization_id: "org-a", ...overrides }
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    ...scope(),
    project_id: "project_1",
    document_id: "document_1",
    revision_id: "document_revision_1",
    title: "Launch",
    markdown: "# Launch",
    content_hash: "df1e79ca2a1b6778e23b1419d39f840201d65bd85531e9464bdd86bad678c046",
    authored_by_type: "user",
    authored_by_id: "user-a",
    authored_at: 10,
    ...overrides,
  }
}

function fixture() {
  return new MemoryDb({
    users: [
      { _id: "user-row-a", token_identifier: "token-a", clerk_subject: "user-a" },
      { _id: "user-row-b", token_identifier: "token-b", clerk_subject: "user-b" },
    ],
    orgs: [
      { _id: "org-a", name: "A" },
      { _id: "org-b", name: "B" },
    ],
    org_memberships: [
      { _id: "membership-a", org_id: "org-a", user_id: "user-row-a", role: "owner" },
      { _id: "membership-b", org_id: "org-b", user_id: "user-row-b", role: "owner" },
    ],
    projects: [
      { _id: "project-row-1", project_id: "project_1", org_id: "org-a", owner_user_id: "user-row-a" },
      { _id: "project-row-2", project_id: "project_2", org_id: "org-b", owner_user_id: "user-row-b" },
    ],
    project_memberships: [],
    documents: [],
    document_revisions: [],
  })
}

function invoke(fn: unknown, db: MemoryDb, args: Record<string, unknown>) {
  return (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler(
    { db },
    { service_token: "service-secret", ...args },
  )
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

class MemoryDb {
  rows: Record<string, Array<Record<string, any>>>
  private next = 0

  constructor(rows: Record<string, Array<Record<string, any>>>) {
    this.rows = rows
  }

  query(table: string) {
    let selected = [...(this.rows[table] ?? [])]
    const chain = {
      withIndex: (_name: string, build: (query: any) => unknown) => {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = []
        const query = {
          eq: (field: string, value: unknown) => {
            predicates.push((row) => row[field] === value)
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => predicates.every((predicate) => predicate(row)))
        return chain
      },
      unique: async () => selected[0] ?? null,
      collect: async () => selected,
    }
    return chain
  }

  async get(id: string) {
    return (
      Object.values(this.rows)
        .flat()
        .find((row) => row._id === id) ?? null
    )
  }

  async insert(table: string, value: Record<string, unknown>) {
    const id = `${table}-${++this.next}`
    ;(this.rows[table] ??= []).push({ _id: id, ...value })
    return id
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = await this.get(id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }
}
