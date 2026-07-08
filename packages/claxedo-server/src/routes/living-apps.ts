import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ClaxedoDB, and, desc, eq } from "../storage/db"
import { errorBody } from "./http"
// Tables live in `storage/living-app.sql.ts`, not the
// monolithic `schema.ts`. The wrong import path was inherited from
// the old single-file schema layout.
import {
  ClaxedoLivingAppDataSourceTable,
  ClaxedoLivingAppEventTable,
  ClaxedoLivingAppTable,
} from "../storage/living-app.sql"

const statusSchema = z.enum(["active", "paused", "archived"])
const syncConfigSchema = z
  .object({
    provider: z.enum(["local-sqlite", "turso"]).default("local-sqlite"),
    local_path: z.string().optional(),
    remote_url: z.string().url().optional(),
    auth_secret_ref: z.string().optional(),
    sync_interval_seconds: z.number().int().positive().optional(),
    offline: z.boolean().optional(),
  })
  .passthrough()

const createAppBody = z.object({
  workspace_id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: statusSchema.optional(),
  shell_spec: z.unknown().optional(),
  backend_contract: z.unknown().optional(),
  action_bindings: z.unknown().optional(),
  data_schema: z.unknown().optional(),
  sync_config: syncConfigSchema.optional(),
  prompt: z.string().optional(),
  source_session_id: z.string().nullable().optional(),
  process_ref: z.string().nullable().optional(),
})

const updateAppBody = createAppBody.partial().extend({
  name: z.string().min(1).optional(),
})

const dataSourceBody = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  config: z.unknown().optional(),
})

const updateDataSourceBody = dataSourceBody.partial()

const eventBody = z.object({
  type: z.string().min(1),
  payload: z.unknown().optional(),
})

type LivingAppRow = typeof ClaxedoLivingAppTable.$inferSelect
type DataSourceRow = typeof ClaxedoLivingAppDataSourceTable.$inferSelect
type EventRow = typeof ClaxedoLivingAppEventTable.$inferSelect

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`
}

function json(value: unknown, fallback: unknown) {
  return JSON.stringify(value ?? fallback)
}

function parseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function invalidBody(error: z.ZodError) {
  return errorBody("living_app_invalid_body", "Invalid Living App request body", error.flatten())
}

function notFound() {
  return errorBody("living_app_not_found", "Living App not found")
}

function dataSourceNotFound() {
  return errorBody("living_app_data_source_not_found", "Living App data source not found")
}

function appView(row: LivingAppRow) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    shell_spec: parseJson(row.shell_spec_json),
    backend_contract: parseJson(row.backend_contract_json),
    action_bindings: parseJson(row.action_bindings_json),
    data_schema: parseJson(row.data_schema_json),
    sync_config: parseJson(row.sync_config_json),
    prompt: row.prompt,
    source_session_id: row.source_session_id,
    process_ref: row.process_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function dataSourceView(row: DataSourceRow) {
  return {
    id: row.id,
    app_id: row.app_id,
    kind: row.kind,
    label: row.label,
    config: parseJson(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function eventView(row: EventRow) {
  return {
    id: row.id,
    app_id: row.app_id,
    type: row.type,
    payload: parseJson(row.payload_json),
    created_at: row.created_at,
  }
}

function getApp(appId: string) {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoLivingAppTable)
      .where(eq(ClaxedoLivingAppTable.id, appId))
      .get(),
  )
}

function listApps(workspaceId?: string) {
  return ClaxedoDB.use((db) => {
    if (workspaceId) {
      return db
        .select()
        .from(ClaxedoLivingAppTable)
        .where(eq(ClaxedoLivingAppTable.workspace_id, workspaceId))
        .orderBy(desc(ClaxedoLivingAppTable.updated_at))
        .all()
    }
    return db.select().from(ClaxedoLivingAppTable).orderBy(desc(ClaxedoLivingAppTable.updated_at)).all()
  })
}

export function LivingAppsRoutes() {
  return new Hono()
    .get("/", (c) => c.json({ apps: listApps(c.req.query("workspace_id")).map(appView) }))
    .post("/", async (c) => {
      const body = createAppBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)

      const now = Date.now()
      const row: typeof ClaxedoLivingAppTable.$inferInsert = {
        id: id("app"),
        workspace_id: body.data.workspace_id,
        name: body.data.name.trim(),
        description: body.data.description?.trim() ?? "",
        status: body.data.status ?? "active",
        shell_spec_json: json(body.data.shell_spec, {}),
        backend_contract_json: json(body.data.backend_contract, {}),
        action_bindings_json: json(body.data.action_bindings, {}),
        data_schema_json: json(body.data.data_schema, {}),
        sync_config_json: json(body.data.sync_config, { provider: "local-sqlite" }),
        prompt: body.data.prompt ?? "",
        source_session_id: body.data.source_session_id ?? null,
        process_ref: body.data.process_ref ?? null,
        created_at: now,
        updated_at: now,
      }
      ClaxedoDB.use((db) => db.insert(ClaxedoLivingAppTable).values(row).run())
      return c.json({ app: appView(row as LivingAppRow) }, 201)
    })
    .get("/:id", (c) => {
      const row = getApp(c.req.param("id"))
      if (!row) return c.json(notFound(), 404)
      return c.json({ app: appView(row) })
    })
    .patch("/:id", async (c) => {
      const body = updateAppBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const row = getApp(c.req.param("id"))
      if (!row) return c.json(notFound(), 404)

      const next: typeof ClaxedoLivingAppTable.$inferInsert = {
        ...row,
        workspace_id: body.data.workspace_id ?? row.workspace_id,
        name: body.data.name?.trim() ?? row.name,
        description: body.data.description?.trim() ?? row.description,
        status: body.data.status ?? row.status,
        shell_spec_json: body.data.shell_spec === undefined ? row.shell_spec_json : json(body.data.shell_spec, {}),
        backend_contract_json: body.data.backend_contract === undefined ? row.backend_contract_json : json(body.data.backend_contract, {}),
        action_bindings_json: body.data.action_bindings === undefined ? row.action_bindings_json : json(body.data.action_bindings, {}),
        data_schema_json: body.data.data_schema === undefined ? row.data_schema_json : json(body.data.data_schema, {}),
        sync_config_json: body.data.sync_config === undefined ? row.sync_config_json : json(body.data.sync_config, { provider: "local-sqlite" }),
        prompt: body.data.prompt ?? row.prompt,
        source_session_id: body.data.source_session_id === undefined ? row.source_session_id : body.data.source_session_id,
        process_ref: body.data.process_ref === undefined ? row.process_ref : body.data.process_ref,
        updated_at: Date.now(),
      }
      ClaxedoDB.use((db) =>
        db
          .update(ClaxedoLivingAppTable)
          .set(next)
          .where(eq(ClaxedoLivingAppTable.id, row.id))
          .run(),
      )
      return c.json({ app: appView(next as LivingAppRow) })
    })
    .delete("/:id", (c) => {
      const row = getApp(c.req.param("id"))
      if (!row) return c.json({ deleted: false, ...notFound() }, 404)
      ClaxedoDB.transaction((db) => {
        db.delete(ClaxedoLivingAppDataSourceTable).where(eq(ClaxedoLivingAppDataSourceTable.app_id, row.id)).run()
        db.delete(ClaxedoLivingAppEventTable).where(eq(ClaxedoLivingAppEventTable.app_id, row.id)).run()
        db.delete(ClaxedoLivingAppTable).where(eq(ClaxedoLivingAppTable.id, row.id)).run()
      })
      return c.json({ deleted: true })
    })
    .get("/:id/data-sources", (c) => {
      if (!getApp(c.req.param("id"))) return c.json(notFound(), 404)
      return c.json({
        data_sources: ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoLivingAppDataSourceTable)
            .where(eq(ClaxedoLivingAppDataSourceTable.app_id, c.req.param("id")))
            .orderBy(desc(ClaxedoLivingAppDataSourceTable.updated_at))
            .all(),
        ).map(dataSourceView),
      })
    })
    .post("/:id/data-sources", async (c) => {
      if (!getApp(c.req.param("id"))) return c.json(notFound(), 404)
      const body = dataSourceBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const now = Date.now()
      const row: typeof ClaxedoLivingAppDataSourceTable.$inferInsert = {
        id: id("source"),
        app_id: c.req.param("id"),
        kind: body.data.kind,
        label: body.data.label,
        config_json: json(body.data.config, {}),
        created_at: now,
        updated_at: now,
      }
      ClaxedoDB.use((db) => db.insert(ClaxedoLivingAppDataSourceTable).values(row).run())
      return c.json({ data_source: dataSourceView(row as DataSourceRow) }, 201)
    })
    .patch("/:id/data-sources/:sourceId", async (c) => {
      const body = updateDataSourceBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const row = ClaxedoDB.use((db) =>
        db
          .select()
          .from(ClaxedoLivingAppDataSourceTable)
          .where(
            and(
              eq(ClaxedoLivingAppDataSourceTable.id, c.req.param("sourceId")),
              eq(ClaxedoLivingAppDataSourceTable.app_id, c.req.param("id")),
            ),
          )
          .get(),
      )
      if (!row) return c.json(dataSourceNotFound(), 404)
      const next: typeof ClaxedoLivingAppDataSourceTable.$inferInsert = {
        ...row,
        kind: body.data.kind ?? row.kind,
        label: body.data.label ?? row.label,
        config_json: body.data.config === undefined ? row.config_json : json(body.data.config, {}),
        updated_at: Date.now(),
      }
      ClaxedoDB.use((db) =>
        db
          .update(ClaxedoLivingAppDataSourceTable)
          .set(next)
          .where(eq(ClaxedoLivingAppDataSourceTable.id, row.id))
          .run(),
      )
      return c.json({ data_source: dataSourceView(next as DataSourceRow) })
    })
    .delete("/:id/data-sources/:sourceId", (c) => {
      ClaxedoDB.use((db) =>
        db
          .delete(ClaxedoLivingAppDataSourceTable)
          .where(
            and(
              eq(ClaxedoLivingAppDataSourceTable.id, c.req.param("sourceId")),
              eq(ClaxedoLivingAppDataSourceTable.app_id, c.req.param("id")),
            ),
          )
          .run(),
      )
      return c.json({ deleted: true })
    })
    .get("/:id/events", (c) => {
      if (!getApp(c.req.param("id"))) return c.json(notFound(), 404)
      return c.json({
        events: ClaxedoDB.use((db) =>
          db
            .select()
            .from(ClaxedoLivingAppEventTable)
            .where(eq(ClaxedoLivingAppEventTable.app_id, c.req.param("id")))
            .orderBy(desc(ClaxedoLivingAppEventTable.created_at))
            .limit(100)
            .all(),
        ).map(eventView),
      })
    })
    .post("/:id/events", async (c) => {
      if (!getApp(c.req.param("id"))) return c.json(notFound(), 404)
      const body = eventBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const row: typeof ClaxedoLivingAppEventTable.$inferInsert = {
        id: id("event"),
        app_id: c.req.param("id"),
        type: body.data.type,
        payload_json: json(body.data.payload, {}),
        created_at: Date.now(),
      }
      ClaxedoDB.use((db) => db.insert(ClaxedoLivingAppEventTable).values(row).run())
      return c.json({ event: eventView(row as EventRow) }, 201)
    })
}
