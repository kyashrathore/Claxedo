/**
 * Process Management Routes
 *
 * HTTP routes for managing long-running processes (dev servers, watchers, etc.)
 */

import { Hono, type Context } from "hono"
import { Pty } from "../pty/index"
import { Process } from "../managed-processes/schema"
import * as ProcessManager from "../managed-processes/manager"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import { assertTarget, authoritativeWorkspaceId, resolveWorkspaceCommandPaths, resolveWorkspacePath, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { denyWorkspaceViewers } from "./workspace-role"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessPolicy,
} from "../session-access-policy"

function dir(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string {
  return assertTarget(c.req.query("directory") || c.req.header("x-claxedo-directory"))
}

/**
 * Name the workspace whose port leases this directory's processes hold.
 *
 * The caller used to name it, through `x-workspace-id`. That string becomes a
 * directory under the lease root, and `loadConfig` prunes every lease in the
 * directory it is handed — so a request could delete another workspace's
 * leases by claiming to be it. Only this runtime knows which workspace it was
 * placed for; with no such identity the manager's own `real(directory)` is the
 * label, which is derived rather than claimed.
 */
function bind(directory: string) {
  ProcessManager.bindWorkspace(directory, authoritativeWorkspaceId())
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
    get(id: string): { id: string; sessionId?: string } | undefined
    snapshot(id: string): string
    accessOwner?(id: string): string | undefined
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

async function processLogs(
  c: Context<{ Variables: RelayHostAuthContext }>,
  directory: string,
  deps: CreateProcessRoutesDeps,
  policy: SessionAccessPolicy,
) {
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

  const info = deps.pty.get(ptyId)
  if (!info) return c.json(processLogNotFound(`PTY ${ptyId} not found`, { pty_id: ptyId }), 404)
  const access = sessionAccessContext(c)
  if (access.authority) {
    if (!info.sessionId) return c.json(processLogNotFound(`PTY ${ptyId} not found`, { pty_id: ptyId }), 404)
    const decision = await policy.authorize({
      ...access,
      operation: "pty_read",
      sessionId: info.sessionId,
      method: c.req.method,
      path: c.req.path,
    })
    if (!decision.allowed) return sessionAccessDenied(decision)
  }
  return c.text(tailLogSnapshot(deps.pty.snapshot(ptyId), c.req.query("lines")))
}

async function init(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }) {
  const directory = dir(c)
  bind(directory)
  await ProcessManager.initialize(directory)
  return directory
}

async function validateConfig(directory: string, config: Partial<Process.ProcessConfig>) {
  if (config.cwd) await resolveWorkspacePath(directory, config.cwd)
  await resolveWorkspaceCommandPaths(directory, {
    command: config.command,
    args: config.args,
    allowAbsoluteExecutable: true,
  })
}

function createFullProcessRoutes(policy: SessionAccessPolicy) {
  return (
  new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) {
        return c.json(requestBodyTooLargeBody(), 413)
      }
      if (err instanceof WorkspaceTargetError) {
        if (!err.message.includes("pinned")) {
          return c.json(errorBody("process_invalid_path", err.message), 400)
        }
        return c.json(errorBody("process_invalid_directory", "Process directory must match configured workspace"), 400)
      }
      throw err
    })
    .use("*", denyWorkspaceViewers("Workspace role does not allow process access"))
    .get("/", async (c) => {
      const directory = await init(c)
      const configs = ProcessManager.configs(directory)
      const processes = ProcessManager.list(directory)
      return c.json({ configs, processes })
    })
    .post("/", async (c) => {
      const directory = await init(c)
      // `ProcessConfig` is the schema `addConfig` parses with anyway; running it
      // here turns an invalid body into a 400 instead of a thrown ZodError, and
      // removes the asserted shape this route used to claim for the raw JSON.
      const parsed = Process.ProcessConfig.safeParse(await boundedJsonBody(c))
      if (!parsed.success) return c.json(errorBody("process_invalid_config", "Invalid process config"), 400)
      await validateConfig(directory, parsed.data)
      const config = await ProcessManager.addConfig(directory, parsed.data)
      return c.json(config, 201)
    })
    .put("/:id", async (c) => {
      const directory = await init(c)
      const id = c.req.param("id")
      const parsedUpdates = Process.ProcessConfig.partial().safeParse(await boundedJsonBody(c))
      if (!parsedUpdates.success) return c.json(errorBody("process_invalid_config", "Invalid process config"), 400)
      const { id: _ignoredId, ...updates } = parsedUpdates.data
      try {
        const existing = ProcessManager.configs(directory).find((config) => config.id === id)
        if (existing) await validateConfig(directory, { ...existing, ...updates })
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
      const launch = Process.LaunchRequest.safeParse(await boundedJsonBody(c) ?? {})
      const result = await ProcessManager.start(directory, id, {
        portConflict: launch.success ? launch.data.portConflict : undefined,
        routeConflict: launch.success ? launch.data.routeConflict : undefined,
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
    .get("/port-map", async (c) => {
      const directory = await init(c)
      return c.json(ProcessManager.portMap(directory))
    })
    .get("/logs", async (c) => {
      const directory = await init(c)
      return processLogs(c, directory, { manager: ProcessManager, pty: Pty }, policy)
    })
  )
}

export function ProcessRoutes(policy?: SessionAccessPolicy) {
  return createFullProcessRoutes(policy ?? managedWorkspaceSessionAccessPolicy())
}

/**
 * Dependency-injected variant of the /logs route used by the focused
 * routes/process.test.ts contract. The production route above uses the same
 * resolution helper with the global ProcessManager and Pty singletons.
 */
export function createProcessRoutes(
  deps: CreateProcessRoutesDeps,
  policy: SessionAccessPolicy = managedWorkspaceSessionAccessPolicy(),
) {
  return new Hono<{ Variables: RelayHostAuthContext }>().get("/logs", async (c) => {
    try {
      return await processLogs(c, dir(c), deps, policy)
    } catch (err) {
      if (err instanceof WorkspaceTargetError) {
        return c.json(errorBody("process_invalid_directory", "Process directory must match configured workspace"), 400)
      }
      throw err
    }
    })
}
