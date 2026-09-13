import { utf8ByteLength } from "@claxedo/helpers/string"
import { Hono } from "hono"
import type { Context } from "hono"
import {
  TASKS_BOUNDS,
  TASKS_PROTOCOL_VERSION,
  CONFIGURATION_SLOTS,
  type InvalidField,
  type TasksActor,
  type TasksCapabilities,
  type TasksErrorCode,
  type TasksErrorDetail,
} from "../contracts"
import { createTasksCommands } from "../commands"
import { TasksError, tasksErrorDetail } from "../errors"
import type { TasksAuthorizationPort } from "../ports/authorization"
import type { TasksCapabilitiesPort } from "../ports/capabilities"
import type { TasksClockPort } from "../ports/clock"
import type { TasksIdsPort } from "../ports/ids"
import type { TasksSessionBridgePort } from "../ports/session-bridge"
import type { TasksStorePort } from "../ports/store"
import { createPresetsService } from "../presets/service"
import { createTasksService } from "../tasks/service"

import {
  parseChildListQuery,
  parseCommandRequest,
  parsePresetListQuery,
  parseStartPreviewRequest,
  parseStartRequest,
  parseTaskListQuery,
} from "./parse"

export type TasksAuthenticated = { actor: TasksActor } | { error: string; status: 401 | 403 }

/** Hosts close over their own principal resolution; the package never sees a credential. */
export type TasksAuthenticate = (request: Request) => Promise<TasksAuthenticated> | TasksAuthenticated

export type TasksRoutesOptions = {
  store: TasksStorePort
  authorization: TasksAuthorizationPort
  authenticate: TasksAuthenticate
  bridge: TasksSessionBridgePort
  capabilities: TasksCapabilitiesPort
  clock: TasksClockPort
  ids: TasksIdsPort
}

const STATUS_BY_CODE: Record<TasksErrorCode, 400 | 403 | 404 | 409 | 422> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  stale_revision: 409,
  conflict: 409,
  unsupported: 422,
}

function refusalResponse(c: Context, detail: TasksErrorDetail) {
  return c.json({ error: detail }, STATUS_BY_CODE[detail.code])
}

function invalidResponse(c: Context, message: string, fields: readonly InvalidField[]) {
  return refusalResponse(c, tasksErrorDetail("invalid_input", message, { fields }))
}

type BodyRead = { ok: true; value: unknown } | { ok: false; response: Response }

/**
 * Reads a JSON body under a byte ceiling. The declared length is refused
 * before the body is touched, the received bytes are counted before they are
 * parsed, and anything that is not JSON is a 400 — never a coerced value.
 */
async function readJson(c: Context, maxBytes: number): Promise<BodyRead> {
  const declared = c.req.header("content-length")
  if (declared !== undefined && Number(declared) > maxBytes) {
    return { ok: false, response: c.json({ error: tasksErrorDetail("invalid_input", `Request exceeds ${maxBytes} bytes`) }, 413) }
  }
  const text = await c.req.text()
  if (utf8ByteLength(text) > maxBytes) {
    return { ok: false, response: c.json({ error: tasksErrorDetail("invalid_input", `Request exceeds ${maxBytes} bytes`) }, 413) }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, response: c.json({ error: tasksErrorDetail("invalid_input", "Request body is not JSON") }, 400) }
  }
}

export function createTasksRoutes(options: TasksRoutesOptions): Hono {
  const app = new Hono()
  const presets = createPresetsService({
    store: options.store,
    clock: options.clock,
    ids: options.ids,
    capabilities: options.capabilities,
  })
  const tasks = createTasksService({
    store: options.store,
    clock: options.clock,
    ids: options.ids,
    authorization: options.authorization,
    bridge: options.bridge,
  })
  const commands = createTasksCommands({
    store: options.store,
    clock: options.clock,
    ids: options.ids,
    capabilities: options.capabilities,
    authorization: options.authorization,
    bridge: options.bridge,
  })

  app.onError((cause, c) => {
    if (cause instanceof TasksError) return refusalResponse(c, cause.detail)
    throw cause
  })

  const actorOf = async (c: Context): Promise<{ actor: TasksActor } | { response: Response }> => {
    const authenticated = await options.authenticate(c.req.raw)
    if ("actor" in authenticated) return { actor: authenticated.actor }
    return { response: c.json({ error: tasksErrorDetail("forbidden", authenticated.error) }, authenticated.status) }
  }

  app.get("/capabilities", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const host = await options.capabilities.describe()
    const body: TasksCapabilities = {
      protocolVersion: TASKS_PROTOCOL_VERSION,
      placements: host.placements,
      cloudSelectedCapabilities: host.cloudSelectedCapabilities,
      instructions: host.instructions,
      configurationSlots: CONFIGURATION_SLOTS,
      bounds: TASKS_BOUNDS,
    }
    return c.json(body)
  })

  app.get("/presets", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const query = parsePresetListQuery(new URL(c.req.url).searchParams)
    if (!query.ok) return invalidResponse(c, "The preset query is not valid", query.fields)
    return c.json(await presets.list(authenticated.actor, query.value))
  })

  app.get("/presets/:presetId", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    return c.json({ preset: await presets.get(authenticated.actor, c.req.param("presetId")) })
  })

  app.get("/tasks", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const query = parseTaskListQuery(new URL(c.req.url).searchParams)
    if (!query.ok) return invalidResponse(c, "The task query is not valid", query.fields)
    return c.json(await tasks.list(authenticated.actor, query.value))
  })

  app.get("/tasks/:taskId/children", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const query = parseChildListQuery(new URL(c.req.url).searchParams)
    if (!query.ok) return invalidResponse(c, "The child query is not valid", query.fields)
    return c.json(await tasks.children(authenticated.actor, c.req.param("taskId"), query.value))
  })

  app.get("/tasks/:taskId", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    return c.json(await tasks.detail(authenticated.actor, c.req.param("taskId")))
  })

  app.post("/commands", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const body = await readJson(c, TASKS_BOUNDS.commandRequestMaxBytes)
    if (!body.ok) return body.response
    const request = parseCommandRequest(body.value)
    if (!request.ok) return invalidResponse(c, "The command is not valid", request.fields)
    return c.json(await commands.execute(authenticated.actor, request.value))
  })

  app.post("/tasks/:taskId/start-preview", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const body = await readJson(c, TASKS_BOUNDS.startRequestMaxBytes)
    if (!body.ok) return body.response
    const request = parseStartPreviewRequest(body.value)
    if (!request.ok) return invalidResponse(c, "The preview request is not valid", request.fields)
    return c.json({ preview: await tasks.startPreview(authenticated.actor, c.req.param("taskId"), request.value) })
  })

  app.post("/tasks/:taskId/sessions", async (c) => {
    const authenticated = await actorOf(c)
    if ("response" in authenticated) return authenticated.response
    const body = await readJson(c, TASKS_BOUNDS.startRequestMaxBytes)
    if (!body.ok) return body.response
    const request = parseStartRequest(body.value)
    if (!request.ok) return invalidResponse(c, "The start request is not valid", request.fields)
    return c.json(await tasks.start(authenticated.actor, c.req.param("taskId"), request.value))
  })

  return app
}
