/**
 * Process Management Routes
 *
 * HTTP routes for managing long-running processes (dev servers, watchers, etc.)
 */

import { Hono } from "hono"
import z from "zod"
import { lazy } from "../lazy"
import { Pty } from "../pty/index"
import { Process } from "../process/process"
import * as ProcessManager from "../process/index"
import { collectDiagnostics, terminateDiagnostic } from "../process/diagnostics"

function dir(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string {
  return c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
}

function bind(c: { req: { header: (k: string) => string | undefined } }, directory: string) {
  ProcessManager.bindWorkspace(directory, c.req.header("x-workspace-id"))
}

async function init(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }) {
  const directory = dir(c)
  bind(c, directory)
  await ProcessManager.loadConfig(directory)
  ProcessManager.watchConfig(directory)
  return directory
}

export const ProcessRoutes = lazy(() =>
  new Hono()
    .get("/", async (c) => {
      const directory = await init(c)
      const configs = ProcessManager.configs(directory)
      const processes = ProcessManager.list(directory)
      return c.json({ configs, processes })
    })
    .post("/", async (c) => {
      const directory = await init(c)
      const body = await c.req.json().catch(() => ({}))
      const config = await ProcessManager.addConfig(directory, body)
      return c.json(config, 201)
    })
    .put("/:id", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const updates = await c.req.json().catch(() => ({}))
      try {
        const updated = await ProcessManager.updateConfig(directory, id, updates)
        return c.json(updated)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("not found")) return c.json({ error: msg }, 404)
        throw err
      }
    })
    .delete("/:id", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      try {
        await ProcessManager.removeConfig(directory, id)
        return c.json(true)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("not found")) return c.json({ error: msg }, 404)
        throw err
      }
    })
    .post("/:id/start", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const body = await c.req.json().catch(() => undefined) as { portConflict?: Process.PortConflictStrategy } | undefined
      const result = await ProcessManager.start(directory, id, {
        portConflict: body?.portConflict,
      })
      if (result.kind === "port_conflict") {
        return c.json(result, 409)
      }
      if (result.kind === "not_found") {
        return c.json(result, 404)
      }
      if (result.kind === "failed") {
        return c.json(result, 500)
      }
      return c.json(result, 200)
    })
    .post("/:id/stop", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      await ProcessManager.stop(directory, id)
      return c.json(true)
    })
    .post("/:id/restart", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const result = await ProcessManager.restart(directory, id)
      if (result.kind === "not_found") {
        return c.json(result, 404)
      }
      if (result.kind === "failed") {
        return c.json(result, 500)
      }
      return c.json(result, 200)
    })
    .post("/start-all", async (c) => {
      const directory = await init(c)
      await ProcessManager.startAll(directory)
      return c.json(true)
    })
    .post("/stop-all", async (c) => {
      const directory = await init(c)
      await ProcessManager.stopAll(directory)
      return c.json(true)
    })
    .get("/diagnostics", async (c) => {
      const directory = await init(c)
      const snapshot = await collectDiagnostics({
        directory,
        workspaceId: c.req.header("x-workspace-id") || undefined,
        configs: ProcessManager.configs(directory),
        processes: ProcessManager.list(directory),
        ptys: Pty.listDetailed(),
      })
      return c.json(snapshot)
    })
    .post("/diagnostics/terminate", async (c) => {
      const directory = await init(c)
      const body = await c.req.json().catch(() => ({}))
      const parsed = Process.DiagnosticTerminateInput.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400)
      }
      const input = parsed.data
      if (input.process_id) {
        await ProcessManager.stop(directory, input.process_id, input.signal)
        return c.json(true)
      }
      if (input.pty_id) {
        await Pty.remove(input.pty_id)
        return c.json(true)
      }
      await terminateDiagnostic(
        input,
        input.group_key
          ? await collectDiagnostics({
              directory,
              workspaceId: c.req.header("x-workspace-id") || undefined,
              configs: ProcessManager.configs(directory),
              processes: ProcessManager.list(directory),
              ptys: Pty.listDetailed(),
            })
          : undefined,
      )
      return c.json(true)
    })
    .get("/port-map", async (c) => {
      const directory = await init(c)
      return c.json(ProcessManager.portMap(directory))
    })
    .get("/logs", async (c) => {
      const directory = await init(c)
      const pty_id = c.req.query("pty_id")
      const terminal_id = c.req.query("terminal_id")
      const process_id = c.req.query("process_id")
      const name = c.req.query("name")
      const linesParam = c.req.query("lines")
      const maxLines = linesParam ? Math.min(Math.max(1, parseInt(linesParam, 10)), 10000) : 100

      let ptyId: string | undefined

      if (pty_id) {
        ptyId = pty_id
      } else if (terminal_id) {
        ptyId = terminal_id
      } else if (process_id) {
        const proc = ProcessManager.get(directory, process_id)
        ptyId = proc?.ptyId
        if (!ptyId) {
          return c.json({ error: `Process ${process_id} not found or has no PTY` }, 404)
        }
      } else if (name) {
        const proc = ProcessManager.findByName(directory, name)
        ptyId = proc?.ptyId
        if (!ptyId) {
          return c.json({ error: `Process named '${name}' not found or has no PTY` }, 404)
        }
      } else {
        return c.json({ error: "Provide one of: pty_id, terminal_id, process_id, name" }, 400)
      }

      const ptyInfo = Pty.get(ptyId)
      if (!ptyInfo) {
        return c.json({ error: `PTY ${ptyId} not found` }, 404)
      }

      // Buffer reading not implemented in standalone server
      return c.text("")
    }),
)
