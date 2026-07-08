import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { ClaxedoDB } from "../storage/db"
import { errorBody } from "./http"
import {
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "../control-plane/auth"
import type { ProjectAction } from "../control-plane/authority"
import { isLoopbackLocalRequest } from "./local-only-projection"
import { compactDocument } from "./page-arena-format"
import {
  arenaRuntime,
  arenaSettings,
  arenaState,
  createArenaConfig,
  createArenaSession,
  emitArenaEvent,
  onArenaEvent,
  parseMentions,
  runArenaWave,
} from "./page-arena-runtime"
import {
  addMessage,
  agentsForArena,
  arenaForPage,
  asJson,
  clean,
  hash,
  id,
  latestUserMessage,
  latestWave,
  now,
  updateArena,
  updateWave,
} from "./page-arena-store"

export { clean } from "./page-arena-store"

export type PageArenaRouteOptions = {
  env?: Record<string, string | undefined>
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  authorizePage?: (request: Request, pageId: string, action: ProjectAction) => Promise<Response | undefined>
}

function arenaNotStarted() {
  return errorBody("page_arena_not_started", "Arena not started")
}

function pickDirectory(query: string, header: string, body: string) {
  return clean(query || header || body)
}

async function authorizeArena(c: any, options: PageArenaRouteOptions, pageID: string, action: ProjectAction) {
  if (options.authorizePage) return await options.authorizePage(c.req.raw, pageID, action)
  if (isLoopbackLocalRequest(c.req.raw)) return
  return new Response(JSON.stringify(errorBody("page_arena_authorizer_required", "Page arena routes require page authorization")), {
    status: 403,
    headers: { "content-type": "application/json" },
  })
}

export function PageArenaRoutes(options: PageArenaRouteOptions = {}) {
  const settings = arenaSettings(options.env)
  return new Hono()
    .post("/start", async (c) => {
      const pageID = c.req.param("id")!
      const authResponse = await authorizeArena(c, options, pageID, "write")
      if (authResponse) return authResponse
      const body = ((await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}) as Record<string, unknown>
      const origin = new URL(c.req.url).origin
      const directory = pickDirectory(
        c.req.query("directory") || "",
        c.req.header("x-opencode-directory") || "",
        clean(body.directory),
      )
      const config = createArenaConfig(body, settings)
      const parentInput = clean(body.parent_session_id || body.parentSessionId)

      const existing = arenaForPage(pageID)
      if (
        existing &&
        (existing.status === "running" || existing.status === "paused" || existing.status === "stopping")
      ) {
        const run = arenaRuntime(existing.id)
        run.abort.abort()
        run.paused = false
        updateArena(existing.id, { status: "completed", stop_reason: "restarted" })
      }

      const parentSessionID =
        parentInput ||
        (await createArenaSession(origin, directory, {
          title: `Page Arena • ${pageID}`,
        }))

      const arenaID = id("arena")
      const created = now()
      ClaxedoDB.raw()
        .prepare(
          `INSERT INTO claxedo_page_arena
            (id, page_id, directory, parent_session_id, status, config_json, synopsis, active_wave_id, current_round, stop_reason, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          arenaID,
          pageID,
          directory,
          parentSessionID,
          "idle",
          JSON.stringify(config),
          "",
          "",
          0,
          "",
          "",
          created,
          created,
        )

      for (const row of config.agents) {
        const sessionID = await createArenaSession(origin, directory, {
          parentID: parentSessionID,
          title: `Arena • ${row.name}`,
        })
        const ts = now()
        ClaxedoDB.raw()
          .prepare(
            `INSERT INTO claxedo_page_arena_agent
              (id, arena_id, agent_key, display_name, role, duty, model, style, temperature, session_id, status, settled, last_signal, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id("ara"),
            arenaID,
            row.key,
            row.name,
            row.role,
            row.duty,
            row.model,
            row.style || "",
            row.temperature ?? null,
            sessionID,
            "idle",
            0,
            "",
            ts,
            ts,
          )
      }

      const state = arenaState(pageID)
      emitArenaEvent(arenaID, { type: "arena.started", state })
      return c.json(state)
    })
    .get("/state", async (c) => {
      const pageID = c.req.param("id")!
      const authResponse = await authorizeArena(c, options, pageID, "read")
      if (authResponse) return authResponse
      return c.json(arenaState(pageID))
    })
    .post("/message", async (c) => {
      const pageID = c.req.param("id")!
      const authResponse = await authorizeArena(c, options, pageID, "write")
      if (authResponse) return authResponse
      const body = ((await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}) as Record<string, unknown>
      const text = clean(body.text)
      if (!text) return c.json(errorBody("page_arena_text_required", "text is required"), 400)
      const page_context = compactDocument(typeof body.page_context === "string" ? body.page_context : "", 6000)

      const arena = arenaForPage(pageID)
      if (!arena) return c.json(arenaNotStarted(), 404)
      if (arena.status === "stopping") return c.json(errorBody("page_arena_stopping", "Arena is stopping"), 409)
      if (arenaRuntime(arena.id).processing || arena.status === "running" || arena.status === "paused") {
        return c.json(errorBody("page_arena_busy", "Arena is already processing a wave"), 409)
      }

      const targetInput = Array.isArray(body.targets)
        ? body.targets.map((item) => clean(item)).filter(Boolean)
        : Array.isArray(body.mentions)
          ? body.mentions.map((item) => clean(item)).filter(Boolean)
          : []

      const all = agentsForArena(arena.id)
      const allKeys = all.map((agent) => agent.agent_key)
      const mention = parseMentions(text, allKeys)
      const target = [...new Set([...targetInput, ...mention])].filter((key) => allKeys.includes(key))

      const waveID = id("wave")
      const started = now()
      ClaxedoDB.raw()
        .prepare(
          `INSERT INTO claxedo_page_arena_wave
            (id, arena_id, status, round_num, target_json, termination, started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(waveID, arena.id, "running", 0, JSON.stringify(target), "", started, 0, started)

      const msg = addMessage({
        arena_id: arena.id,
        wave_id: waveID,
        round_num: 0,
        kind: "user",
        source_agent_key: "user",
        text,
        control_signal: "continue",
        metadata: { hash: hash(text), targets: target, ...(page_context ? { page_context } : {}) },
      })

      updateArena(arena.id, {
        status: "running",
        active_wave_id: waveID,
        current_round: 0,
        stop_reason: "",
        last_error: "",
      })

      emitArenaEvent(arena.id, {
        type: "arena.message",
        message: {
          id: msg.id,
          kind: "user",
          source: "user",
          text,
          signal: "continue",
          round: 0,
          meta: { targets: target },
        },
      })

      void runArenaWave({
        origin: new URL(c.req.url).origin,
        page_id: pageID,
        arena_id: arena.id,
        wave_id: waveID,
        settings,
      })

      return c.json({ ok: true, wave_id: waveID, state: arenaState(pageID) })
    })
    .post("/control", async (c) => {
      const pageID = c.req.param("id")!
      const authResponse = await authorizeArena(c, options, pageID, "write")
      if (authResponse) return authResponse
      const body = ((await c.req.json<Record<string, unknown>>().catch(() => ({}))) || {}) as Record<string, unknown>
      const action = clean(body.action)
      const arena = arenaForPage(pageID)
      if (!arena) return c.json(arenaNotStarted(), 404)

      const runtime = arenaRuntime(arena.id)

      if (action === "pause") {
        runtime.paused = true
        updateArena(arena.id, { status: "paused" })
        emitArenaEvent(arena.id, { type: "arena.status", status: "paused", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "resume") {
        runtime.paused = false
        updateArena(arena.id, { status: "running" })
        emitArenaEvent(arena.id, { type: "arena.status", status: "running", state: arenaState(pageID) })
        const wave = latestWave(arena.id)
        if (wave && wave.status === "running" && !runtime.processing) {
          void runArenaWave({
            origin: new URL(c.req.url).origin,
            page_id: pageID,
            arena_id: arena.id,
            wave_id: wave.id,
            settings,
          })
        }
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "stop") {
        runtime.paused = false
        runtime.abort.abort()
        updateArena(arena.id, { status: "completed", stop_reason: "stopped_by_user", active_wave_id: "" })
        const wave = latestWave(arena.id)
        if (wave && wave.status === "running") {
          updateWave(wave.id, { status: "stopped", termination: "stopped_by_user", finished_at: now() })
        }
        emitArenaEvent(arena.id, { type: "arena.status", status: "completed", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      if (action === "retry") {
        const last = latestUserMessage(arena.id)
        if (!last) return c.json(errorBody("page_arena_retry_unavailable", "No previous user message"), 400)
        const meta = asJson<Record<string, unknown>>(last.metadata_json || "{}", {})
        const target = Array.isArray(meta.targets) ? meta.targets.map((item) => clean(item)).filter(Boolean) : []
        const waveID = id("wave")
        const started = now()
        ClaxedoDB.raw()
          .prepare(
            `INSERT INTO claxedo_page_arena_wave
              (id, arena_id, status, round_num, target_json, termination, started_at, finished_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            waveID,
            arena.id,
            "running",
            0,
            JSON.stringify(Array.isArray(target) ? target : []),
            "",
            started,
            0,
            started,
          )
        addMessage({
          arena_id: arena.id,
          wave_id: waveID,
          round_num: 0,
          kind: "user",
          source_agent_key: "user",
          text: last.text,
          control_signal: "continue",
          metadata: {
            retry_of: last.id,
            ...(typeof meta.page_context === "string" && clean(meta.page_context)
              ? { page_context: compactDocument(meta.page_context, 6000) }
              : {}),
          },
        })
        updateArena(arena.id, {
          status: "running",
          active_wave_id: waveID,
          stop_reason: "",
          last_error: "",
        })
        void runArenaWave({
          origin: new URL(c.req.url).origin,
          page_id: pageID,
          arena_id: arena.id,
          wave_id: waveID,
          settings,
        })
        emitArenaEvent(arena.id, { type: "arena.retry", state: arenaState(pageID) })
        return c.json({ ok: true, state: arenaState(pageID) })
      }

      return c.json(errorBody("page_arena_action_invalid", "Invalid action"), 400)
    })
    .get("/events", async (c) => {
      const pageID = c.req.param("id")!
      const authResponse = await authorizeArena(c, options, pageID, "read")
      if (authResponse) return authResponse
      const arena = arenaForPage(pageID)

      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")

      return streamSSE(c, async (stream) => {
        stream.writeSSE({
          data: JSON.stringify({
            type: "arena.snapshot",
            state: arenaState(pageID),
          }),
        })

        let off = () => {}
        if (arena) {
          off = onArenaEvent(arena.id, async (event) => {
            await stream.writeSSE({ data: JSON.stringify(event) })
          })
        }

        const heartbeat = setInterval(() => {
          stream.writeSSE({
            data: JSON.stringify({ type: "arena.heartbeat", ts: now() }),
          })
        }, 10_000)

        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(heartbeat)
            off()
            resolve()
          })
        })
      })
    })
}
