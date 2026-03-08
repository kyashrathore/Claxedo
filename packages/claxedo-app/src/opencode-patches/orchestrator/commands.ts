/**
 * Orchestrator Command Channel
 *
 * Defines a Bus event and Hono route for frontend → backend commands.
 * Commands let the frontend control orchestration lifecycle:
 * - approve/cancel during review phase
 * - pause/resume during execution
 * - edit/add/remove nodes during review
 * - cancel/restart individual tasks during execution
 */

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Hono } from "hono"
import z from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "orchestrator.commands" })

// ---------------------------------------------------------------------------
// Bus event
// ---------------------------------------------------------------------------

export const OrchestratorCommand = BusEvent.define(
  "orchestrator.command",
  z.object({
    sessionID: z.string(),
    command: z.enum([
      "approve",      // Start execution after review
      "pause",        // Pause execution
      "resume",       // Resume execution
      "cancel",       // Cancel entire orchestration
      "cancel-task",  // Cancel specific task
      "restart-task", // Restart a failed task
      "edit-node",    // Edit node prompt/title during review
      "add-node",     // Add new node during review
      "remove-node",  // Remove node during review
    ]),
    payload: z.any().optional(),
  }),
)

// ---------------------------------------------------------------------------
// Direct command store — uses globalThis to guarantee single instance
// even if this module is loaded multiple times by the build system
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__orchestrator_command_queues__" as const
const ACTIVE_KEY = "__orchestrator_active_sessions__" as const

function getCommandQueues(): Map<string, Array<{ command: string; payload?: any }>> {
  const g = globalThis as any
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map()
  }
  return g[GLOBAL_KEY]
}

function getActiveSessions(): Set<string> {
  const g = globalThis as any
  if (!g[ACTIVE_KEY]) {
    g[ACTIVE_KEY] = new Set()
  }
  return g[ACTIVE_KEY]
}

/** Register a session as actively running (called by tool.ts on start). */
export function registerSession(sessionID: string) {
  getActiveSessions().add(sessionID)
}

/** Unregister a session (called by tool.ts on end). */
export function unregisterSession(sessionID: string) {
  getActiveSessions().delete(sessionID)
  getCommandQueues().delete(sessionID)
}

/** Check if a session's orchestration is actively running. */
export function isSessionActive(sessionID: string): boolean {
  return getActiveSessions().has(sessionID)
}

/** Push a command for a given sessionID (called by route handler). */
export function pushCommand(sessionID: string, command: string, payload?: any) {
  const queues = getCommandQueues()
  let queue = queues.get(sessionID)
  if (!queue) {
    queue = []
    queues.set(sessionID, queue)
  }
  queue.push({ command, payload })
}

/** Drain all pending commands for a sessionID (called by tool.ts). */
export function drainCommands(sessionID: string): Array<{ command: string; payload?: any }> {
  const queues = getCommandQueues()
  const queue = queues.get(sessionID)
  if (!queue || queue.length === 0) return []
  const cmds = [...queue]
  queue.length = 0
  return cmds
}

// ---------------------------------------------------------------------------
// Hono routes
// ---------------------------------------------------------------------------

const CommandBody = z.object({
  sessionID: z.string(),
  command: z.enum([
    "approve",
    "pause",
    "resume",
    "cancel",
    "cancel-task",
    "restart-task",
    "edit-node",
    "add-node",
    "remove-node",
  ]),
  payload: z.any().optional(),
})

export function OrchestratorRoutes() {
  const app = new Hono()

  // Check if orchestration is alive
  app.get("/:sessionID/status", async (c) => {
    const sessionID = c.req.param("sessionID")
    return c.json({ active: isSessionActive(sessionID) })
  })

  app.post("/:sessionID/command", async (c) => {
    const sessionID = c.req.param("sessionID")
    let body: z.infer<typeof CommandBody>
    try {
      const raw = await c.req.json()
      body = CommandBody.parse(raw)
    } catch (err) {
      return c.json({ error: "Invalid command body" }, 400)
    }

    // Ensure sessionID in URL matches body
    if (body.sessionID !== sessionID) {
      body.sessionID = sessionID
    }

    // Check if orchestration is still alive
    if (!isSessionActive(body.sessionID)) {
      return c.json({ error: "not_active", message: "Orchestration is no longer running" }, 410)
    }

    log.info("command received", { sessionID, command: body.command })

    // Direct store — reliable delivery
    pushCommand(body.sessionID, body.command, body.payload)

    // Also publish via Bus for any other subscribers (e.g. SSE event stream)
    await Bus.publish(OrchestratorCommand, {
      sessionID: body.sessionID,
      command: body.command,
      payload: body.payload,
    }).catch(() => {})

    return c.json({ ok: true })
  })

  return app
}
