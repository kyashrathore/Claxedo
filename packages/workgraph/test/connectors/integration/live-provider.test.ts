import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import { createApp, initializeDb } from "../../../src/app"

describe("live provider smoke", () => {
  let db: InstanceType<typeof Database>
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = new Database(":memory:")
    initializeDb(db)
    app = createApp(db)
  })

  const github = process.env.LIVE_GITHUB_TOKEN
    && process.env.LIVE_GITHUB_OWNER
    && process.env.LIVE_GITHUB_REPO
    ? test
    : test.skip

  github("queries and imports GitHub work", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        name: "Live GitHub",
        token: process.env.LIVE_GITHUB_TOKEN,
      }),
    })
    expect(create.status).toBe(201)
    const row = await create.json() as any

    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: {
          owner: process.env.LIVE_GITHUB_OWNER,
          repo: process.env.LIVE_GITHUB_REPO,
          limit: 3,
        },
      }),
    })
    expect(query.status).toBe(200)
    const preview = await query.json() as any
    expect(Array.isArray(preview.items)).toBe(true)
    if (!preview.items.length) return

    const imported = await app.request("/graph/providers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: {
          owner: process.env.LIVE_GITHUB_OWNER,
          repo: process.env.LIVE_GITHUB_REPO,
        },
        items: preview.items.slice(0, 2),
      }),
    })
    expect(imported.status).toBe(201)
  })

  const linear = process.env.LIVE_LINEAR_TOKEN && process.env.LIVE_LINEAR_TEAM_ID
    ? test
    : test.skip

  linear("queries and imports Linear work", async () => {
    const create = await app.request("/graph/providers/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "linear",
        name: "Live Linear",
        token: process.env.LIVE_LINEAR_TOKEN,
      }),
    })
    expect(create.status).toBe(201)
    const row = await create.json() as any

    const query = await app.request("/graph/providers/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: {
          team_id: process.env.LIVE_LINEAR_TEAM_ID,
          limit: 3,
        },
      }),
    })
    expect(query.status).toBe(200)
    const preview = await query.json() as any
    expect(Array.isArray(preview.items)).toBe(true)
    if (!preview.items.length) return

    const imported = await app.request("/graph/providers/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection_id: row.connection_id,
        mode: "project_or_team",
        query: {
          team_id: process.env.LIVE_LINEAR_TEAM_ID,
        },
        items: preview.items.slice(0, 2),
      }),
    })
    expect(imported.status).toBe(201)
  })
})
