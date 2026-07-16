/**
 * Process Management Routes
 *
 * HTTP routes for managing long-running processes (dev servers, watchers, etc.)
 */

import { Hono, type Context } from "hono"
import z from "zod/v3"
import { lazy } from "../lazy"
import { Pty } from "../pty/index"
import { Process } from "../managed-processes/schema"
import * as ProcessManager from "../managed-processes/manager"
import { collectDiagnostics, terminateDiagnostic } from "../managed-processes/diagnostics"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { assertTarget, WorkspaceTargetError } from "../target"

function dir(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string {
  return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
}

function bind(c: { req: { header: (k: string) => string | undefined } }, directory: string) {
  ProcessManager.bindWorkspace(directory, c.req.header("x-workspace-id"), c.req.header("x-workspace-name"))
}

function configNotFound(message: string) {
  return errorBody("process_config_not_found", message)
}

function processLogTargetRequired() {
  return errorBody("process_log_target_required", "Provide one of: pty_id, terminal_id, process_id, name")
}

function processLogNotFound(message: string, details?: Record<string, unknown>) {
  return errorBody("process_log_target_not_found", message, details)
}

export type CreateProcessRoutesDeps = {
  manager: {
    get(directory: string, id: string): { ptyId?: string } | undefined
    findByName(directory: string, name: string): { ptyId?: string } | undefined
  }
  pty: {
    get(id: string): { id: string } | undefined
    snapshot(id: string): string
  }
}

function maxLogLines(linesParam?: string) {
  const requested = linesParam ? parseInt(linesParam, 10) : 100
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 10000)
    : 1
}

function tailLogSnapshot(snapshot: string, linesParam?: string) {
  return snapshot.split("\n").slice(-maxLogLines(linesParam)).join("\n")
}

function processLogs(c: Context, directory: string, deps: CreateProcessRoutesDeps) {
  const pty_id = c.req.query("pty_id")
  const terminal_id = c.req.query("terminal_id")
  const process_id = c.req.query("process_id")
  const name = c.req.query("name")

  const ptyId = (() => {
    if (pty_id) return pty_id
    if (terminal_id) return terminal_id
    if (process_id) return deps.manager.get(directory, process_id)?.ptyId
    if (name) return deps.manager.findByName(directory, name)?.ptyId
    return undefined
  })()

  if (!ptyId) {
    if (process_id) {
      return c.json(
        processLogNotFound(`Process ${process_id} not found or has no PTY`, { process_id }),
        404,
      )
    }
    if (name) return c.json(processLogNotFound(`Process named '${name}' not found or has no PTY`, { name }), 404)
    return c.json(processLogTargetRequired(), 400)
  }

  if (!deps.pty.get(ptyId)) return c.json(processLogNotFound(`PTY ${ptyId} not found`, { pty_id: ptyId }), 404)
  return c.text(tailLogSnapshot(deps.pty.snapshot(ptyId), c.req.query("lines")))
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
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) {
        return c.json(requestBodyTooLargeBody(), 413)
      }
      if (err instanceof WorkspaceTargetError) {
        return c.json(errorBody("process_invalid_directory", "Process directory must match configured workspace"), 400)
      }
      throw err
    })
    .get("/", async (c) => {
      const directory = await init(c)
      const configs = ProcessManager.configs(directory)
      const processes = ProcessManager.list(directory)
      return c.json({ configs, processes })
    })
    .post("/", async (c) => {
      const directory = await init(c)
      const body = await boundedJsonBody<Omit<Process.ProcessConfig, "id"> & { id?: string }>(
        c,
        {} as Omit<Process.ProcessConfig, "id"> & { id?: string },
      )
      const config = await ProcessManager.addConfig(directory, body)
      return c.json(config, 201)
    })
    .put("/:id", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const updates = await boundedJsonBody<Partial<Omit<Process.ProcessConfig, "id">>>(c, {})
      try {
        const updated = await ProcessManager.updateConfig(directory, id, updates)
        return c.json(updated)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("not found")) return c.json(configNotFound(msg), 404)
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
        if (msg.includes("not found")) return c.json(configNotFound(msg), 404)
        throw err
      }
    })
    .post("/:id/start", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const body = await boundedJsonBody<
        | { portConflict?: Process.PortConflictStrategy; routeConflict?: Process.PortConflictStrategy }
        | undefined
      >(c, undefined)
      const result = await ProcessManager.start(directory, id, {
        portConflict: body?.portConflict,
        routeConflict: body?.routeConflict,
      })
      if (result.kind === "port_conflict") {
        return c.json(result, 409)
      }
      if (result.kind === "route_conflict") {
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
      const body = await boundedJsonBody<Record<string, unknown>>(c, {})
      const parsed = Process.DiagnosticTerminateInput.safeParse(body)
      if (!parsed.success) {
        return c.json(
          errorBody("process_diagnostic_invalid_body", "Invalid process diagnostic request body", parsed.error.flatten()),
          400,
        )
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
      return processLogs(c, directory, { manager: ProcessManager, pty: Pty })
    }),
)

/**
 * Dependency-injected variant of the /logs route used by the focused
 * routes/process.test.ts contract. The production route above uses the same
 * resolution helper with the global ProcessManager and Pty singletons.
 */
export function createProcessRoutes(deps: CreateProcessRoutesDeps) {
  return new Hono().get("/logs", async (c) => {
    try {
      return processLogs(c, dir(c), deps)
    } catch (err) {
      if (err instanceof WorkspaceTargetError) {
        return c.json(errorBody("process_invalid_directory", "Process directory must match configured workspace"), 400)
      }
      throw err
    }
  })
}
