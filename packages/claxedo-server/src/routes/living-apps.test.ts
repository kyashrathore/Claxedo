import { afterAll, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"

const root = path.join(realpathSync(os.tmpdir()), `living-app-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()
const { LivingAppsRoutes } = await import("./living-apps")

const app = new Hono().route("/api/claxedo/living-apps", LivingAppsRoutes())

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

describe("living app routes", () => {
  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("creates, lists, updates, and deletes a living app shell", async () => {
    const created = await app.request("http://localhost/api/claxedo/living-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "ws_1",
        name: "Hiring intake",
        description: "Candidate pipeline",
        shell_spec: { type: "Stack", children: [] },
        backend_contract: { kind: "openapi", operations: ["listCandidates"] },
        action_bindings: { refresh: { operation: "listCandidates" } },
        data_schema: { tables: ["candidate"] },
        sync_config: {
          provider: "turso",
          local_path: "file:apps/hiring.db",
          remote_url: "libsql://hiring-example.turso.io",
          auth_secret_ref: "credential:turso-hiring",
          sync_interval_seconds: 60,
        },
        prompt: "Build a hiring intake app.",
      }),
    })

    expect(created.status).toBe(201)
    const createdBody = await json(created)
    const createdApp = createdBody.app as Record<string, unknown>
    expect(createdApp.name).toBe("Hiring intake")
    expect(createdApp.sync_config).toMatchObject({
      provider: "turso",
      local_path: "file:apps/hiring.db",
      auth_secret_ref: "credential:turso-hiring",
    })
    expect(createdApp.backend_contract).toMatchObject({ kind: "openapi" })
    expect(createdApp.action_bindings).toMatchObject({ refresh: { operation: "listCandidates" } })

    const listed = await app.request("http://localhost/api/claxedo/living-apps?workspace_id=ws_1")
    expect(listed.status).toBe(200)
    expect((await json(listed)).apps).toHaveLength(1)

    const updated = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "paused",
        shell_spec: { type: "Stack", props: { gap: "2" } },
        action_bindings: { refresh: { operation: "searchCandidates" } },
      }),
    })

    expect(updated.status).toBe(200)
    expect((await json(updated)).app).toMatchObject({
      status: "paused",
      shell_spec: { type: "Stack", props: { gap: "2" } },
      action_bindings: { refresh: { operation: "searchCandidates" } },
    })

    const deleted = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}`, {
      method: "DELETE",
    })
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toMatchObject({ deleted: true })
  })

  test("manages app data sources and activity events", async () => {
    const created = await app.request("http://localhost/api/claxedo/living-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tweet ideas" }),
    })
    const createdApp = (await json(created)).app as Record<string, unknown>

    const source = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/data-sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "browser-tab",
        label: "Twitter research tab",
        config: { tab_id: "tab_1" },
      }),
    })

    expect(source.status).toBe(201)
    const sourceBody = await json(source)
    expect(sourceBody.data_source).toMatchObject({
      kind: "browser-tab",
      label: "Twitter research tab",
      config: { tab_id: "tab_1" },
    })

    const event = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "idea_marked",
        payload: { text: "A remixable idea" },
      }),
    })

    expect(event.status).toBe(201)
    expect((await json(event)).event).toMatchObject({
      type: "idea_marked",
      payload: { text: "A remixable idea" },
    })

    const sources = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/data-sources`)
    expect((await json(sources)).data_sources).toHaveLength(1)

    const events = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/events`)
    expect((await json(events)).events).toHaveLength(1)
  })

  test("returns structured error bodies for validation and missing resources", async () => {
    const invalid = await app.request("http://localhost/api/claxedo/living-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "missing name" }),
    })
    expect(invalid.status).toBe(400)
    expect(await json(invalid)).toMatchObject({
      error: {
        code: "living_app_invalid_body",
        message: "Invalid Living App request body",
      },
    })

    const missing = await app.request("http://localhost/api/claxedo/living-apps/app_missing")
    expect(missing.status).toBe(404)
    expect(await json(missing)).toEqual({
      error: {
        code: "living_app_not_found",
        message: "Living App not found",
      },
    })

    const created = await app.request("http://localhost/api/claxedo/living-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Error surface" }),
    })
    const createdApp = (await json(created)).app as Record<string, unknown>

    const invalidSourceUpdate = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/data-sources/source_missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "" }),
    })
    expect(invalidSourceUpdate.status).toBe(400)
    expect(await json(invalidSourceUpdate)).toMatchObject({
      error: {
        code: "living_app_invalid_body",
        message: "Invalid Living App request body",
      },
    })

    const missingSource = await app.request(`http://localhost/api/claxedo/living-apps/${createdApp.id}/data-sources/source_missing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Still missing" }),
    })
    expect(missingSource.status).toBe(404)
    expect(await json(missingSource)).toEqual({
      error: {
        code: "living_app_data_source_not_found",
        message: "Living App data source not found",
      },
    })
  })
})
