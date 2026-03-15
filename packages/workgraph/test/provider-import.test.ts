import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createApp, initializeDb } from "../src/app"

describe("provider import routes", () => {
  let db: InstanceType<typeof Database>
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = new Database(":memory:")
    initializeDb(db)
    app = createApp(db, {
      providers: {
        github: () => ({
          validate: async () => ({ label: "octocat" }),
          queryIssues: async (_mode: string, _params: Record<string, any>) => [{
            id: "42",
            provider: "github",
            provider_meta: { owner: "acme", repo: "app", issueNumber: 42 },
            title: "GitHub issue",
            description: "Hydrated from GitHub",
            status: "open",
            provider_url: "https://github.com/acme/app/issues/42",
            external_key: "acme/app#42",
          }],
          hydrateIssue: async (params: Record<string, any>) => ({
            id: String(params.issueNumber),
            title: "GitHub issue",
            description: "Hydrated from GitHub",
            status: "open" as const,
            provider_url: "https://github.com/acme/app/issues/42",
            external_key: "acme/app#42",
          }),
          updateIssue: async () => {},
          addComment: async () => {},
          createIssue: async () => ({
            id: "99",
            title: "New issue",
            description: "",
            status: "open" as const,
            provider_url: "https://github.com/acme/app/issues/99",
          }),
        }) as any,
        linear: () => ({
          validate: async () => ({ label: "linear@example.com" }),
          queryIssues: async (_mode: string, _params: Record<string, any>) => [{
            id: "lin_1",
            provider: "linear",
            provider_meta: { issueId: "lin_1" },
            title: "Linear issue",
            description: "Hydrated from Linear",
            status: "in_progress",
            provider_url: "https://linear.app/acme/issue/LIN-1",
            external_key: "LIN-1",
          }],
          hydrateIssue: async (params: Record<string, any>) => ({
            id: params.issueId,
            title: "Linear issue",
            description: "Hydrated from Linear",
            status: "in_progress" as const,
            provider_url: "https://linear.app/acme/issue/LIN-1",
            external_key: "LIN-1",
          }),
          updateIssue: async () => {},
          addComment: async () => {},
          createIssue: async () => ({
            id: "lin_new",
            title: "New linear issue",
            description: "",
            status: "open" as const,
            provider_url: "https://linear.app/acme/issue/LIN-NEW",
          }),
        }) as any,
      },
    })
  })

  test("creates, lists, validates, and deletes provider connections", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", name: "Main GitHub", token: "ghp_test" }),
    })
    expect(create.status).toBe(201)
    const item = await create.json() as any
    expect(item.provider).toBe("github")

    const list = await app.request("/graph/providers/connections")
    expect(list.status).toBe(200)
    const rows = await list.json() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("Main GitHub")

    const check = await app.request(`/graph/providers/connections/${item.connection_id}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(check.status).toBe(200)
    const valid = await check.json() as any
    expect(valid.label).toBe("octocat")

    const gone = await app.request(`/graph/providers/connections/${item.connection_id}`, {
      method: "DELETE",
    })
    expect(gone.status).toBe(200)
    expect(await gone.json()).toEqual({ deleted: true })
  })

  test("replaces the existing connection for the same provider", async () => {
    const first = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", name: "Old GitHub", token: "ghp_old" }),
    })
    expect(first.status).toBe(201)
    const row = await first.json() as any

    const second = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", name: "New GitHub", token: "ghp_new" }),
    })
    expect(second.status).toBe(200)
    const next = await second.json() as any
    expect(next.connection_id).toBe(row.connection_id)
    expect(next.name).toBe("New GitHub")

    const list = await app.request("/graph/providers/connections?provider=github")
    expect(list.status).toBe(200)
    const rows = await list.json() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].connection_id).toBe(row.connection_id)
    expect(rows[0].name).toBe("New GitHub")
  })

  test("queries GitHub preview and imports it into a slice mission", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", token: "ghp_test" }),
    })
    const row = await create.json() as any

    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "assigned_to_me",
        query: { owner: "acme", repo: "app" },
      }),
    })
    expect(query.status).toBe(200)
    const preview = await query.json() as any
    expect(preview.kind).toBe("preview")
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0].external_key).toBe("acme/app#42")

    const imported = await app.request("/graph/providers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "assigned_to_me",
        query: { owner: "acme", repo: "app" },
        items: preview.items,
      }),
    })
    expect(imported.status).toBe(201)
    const body = await imported.json() as any
    expect(body.kind).toBe("imported")
    expect(body.slice.provider).toBe("github")
    expect(body.slice.mission_item_id).toBe(body.mission.item_id)
    expect(body.mission.node_type).toBe("mission")

    const items = await app.request(`/graph/items?slice_id=${body.slice.slice_id}`)
    const list = await items.json() as any[]
    expect(list.some((item) => item.node_type === "mission")).toBe(true)
    expect(list.some((item) => item.provider === "github")).toBe(true)
  })

  test("queries Linear preview", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "linear", token: "lin_api_test" }),
    })
    const row = await create.json() as any

    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: { team_id: "team_123" },
      }),
    })
    expect(query.status).toBe(200)
    const body = await query.json() as any
    expect(body.kind).toBe("preview")
    expect(body.items).toHaveLength(1)
    expect(body.items[0].provider).toBe("linear")
    expect(body.items[0].external_key).toBe("LIN-1")
  })

  test("requires repo_ref when importing provider work without repo identity", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "linear", token: "lin_api_test" }),
    })
    const row = await create.json() as any

    const imported = await app.request("/graph/providers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: { team_id: "team_123" },
      }),
    })

    expect(imported.status).toBe(400)
    expect(await imported.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("repo_ref"),
    }))
  })

  test("uses injected auth when no connection id is provided", async () => {
    app = createApp(db, {
      auth: async (provider) => {
        if (provider !== "github") return null
        return {
          source: "shared_auth",
          token: "ghp_shared",
          name: "Shared GitHub",
        }
      },
      providers: {
        github: () => ({
          queryIssues: async () => [{
            id: "42",
            provider: "github",
            provider_meta: { owner: "acme", repo: "app", issueNumber: 42 },
            title: "GitHub issue",
            description: "Hydrated from GitHub",
            status: "open",
            provider_url: "https://github.com/acme/app/issues/42",
            external_key: "acme/app#42",
          }],
          hydrateIssue: async () => ({
            id: "42",
            title: "GitHub issue",
            description: "Hydrated from GitHub",
            status: "open" as const,
            provider_url: "https://github.com/acme/app/issues/42",
            external_key: "acme/app#42",
          }),
          updateIssue: async () => {},
          addComment: async () => {},
          createIssue: async () => ({
            id: "99",
            title: "New issue",
            description: "",
            status: "open" as const,
            provider_url: "https://github.com/acme/app/issues/99",
          }),
        }) as any,
      },
    })

    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        mode: "assigned_to_me",
        query: { owner: "acme", repo: "app" },
      }),
    })
    expect(query.status).toBe(200)
    const preview = await query.json() as any
    expect(preview.kind).toBe("preview")
    expect(preview.items).toHaveLength(1)

    const imported = await app.request("/graph/providers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        mode: "assigned_to_me",
        query: { owner: "acme", repo: "app" },
        items: preview.items,
      }),
    })
    expect(imported.status).toBe(201)
    const body = await imported.json() as any
    expect(body.kind).toBe("imported")
    expect(body.slice.provider_connection_id).toBeNull()
  })

  test("returns auth_required when provider auth is missing", async () => {
    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "linear",
        mode: "assigned_to_me",
        query: {},
      }),
    })
    expect(query.status).toBe(200)
    expect(await query.json()).toEqual({
      kind: "auth_required",
      provider: "linear",
      message: "WorkGraph could not find Linear credentials for this import.",
      hint: "Sign in with shared auth or keep a legacy WorkGraph token as a fallback.",
    })
  })
})
