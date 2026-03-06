/**
 * Process Management Routes
 *
 * HTTP routes for managing long-running processes (dev servers, watchers, etc.)
 * Follows the lazy(() => new Hono()...) pattern from upstream route files.
 */

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { errors } from "@/server/error"
import { Pty } from "@/pty"
import { Process } from "./process"
import * as ProcessManager from "./index"
import { collectDiagnostics, terminateDiagnostic } from "./diagnostics"

export const ProcessRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List processes",
        description:
          "Get all process configs and their runtime state (status, ptyId, restartCount, etc.)",
        operationId: "process.list",
        responses: {
          200: {
            description: "List of process configs with runtime state",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    configs: Process.ProcessConfig.array(),
                    processes: Process.ManagedProcess.array(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const configs = ProcessManager.configs()
        const processes = ProcessManager.list()
        return c.json({ configs, processes })
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Add process config",
        description:
          "Add a new process configuration. An ID is auto-generated if not provided. " +
          "The config is persisted to .opencode/processes.jsonc.",
        operationId: "process.add",
        responses: {
          201: {
            description: "Created process config",
            content: {
              "application/json": {
                schema: resolver(Process.ProcessConfig),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        Process.ProcessConfig.omit({ id: true }).extend({
          id: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const config = await ProcessManager.addConfig(body)
        return c.json(config, 201)
      },
    )
    .put(
      "/:id",
      describeRoute({
        summary: "Update process config",
        description:
          "Update an existing process configuration by ID. " +
          "If the process is running it will be restarted with the new config.",
        operationId: "process.update",
        responses: {
          200: {
            description: "Updated process config",
            content: {
              "application/json": {
                schema: resolver(Process.ProcessConfig),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", Process.ProcessConfig.partial().omit({ id: true })),
      async (c) => {
        const id = c.req.valid("param").id
        const updates = c.req.valid("json")
        try {
          const updated = await ProcessManager.updateConfig(id, updates)
          return c.json(updated)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("not found")) return c.json({ error: msg }, 404)
          throw err
        }
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Remove process config",
        description:
          "Remove a process configuration by ID. " +
          "If the process is running it will be stopped first.",
        operationId: "process.remove",
        responses: {
          200: {
            description: "Process config removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        try {
          await ProcessManager.removeConfig(id)
          return c.json(true)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("not found")) return c.json({ error: msg }, 404)
          throw err
        }
      },
    )
    .post(
      "/:id/start",
      describeRoute({
        summary: "Start process",
        description: "Start a process by its config ID. Creates a PTY and begins execution.",
        operationId: "process.start",
        responses: {
          200: {
            description: "Process started",
            content: {
              "application/json": {
                schema: resolver(Process.ManagedProcess),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const managed = await ProcessManager.start(id)
        if (!managed) {
          return c.json({ error: "Process config not found" }, 404)
        }
        return c.json(managed)
      },
    )
    .post(
      "/:id/stop",
      describeRoute({
        summary: "Stop process",
        description:
          "Stop a running process by its config ID. " +
          "Sends SIGTERM first, then SIGKILL after timeout.",
        operationId: "process.stop",
        responses: {
          200: {
            description: "Process stopped",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        await ProcessManager.stop(id)
        return c.json(true)
      },
    )
    .post(
      "/:id/restart",
      describeRoute({
        summary: "Restart process",
        description: "Stop and restart a process by its config ID.",
        operationId: "process.restart",
        responses: {
          200: {
            description: "Process restarted",
            content: {
              "application/json": {
                schema: resolver(Process.ManagedProcess),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const managed = await ProcessManager.restart(id)
        if (!managed) {
          return c.json({ error: "Process config not found" }, 404)
        }
        return c.json(managed)
      },
    )
    .post(
      "/start-all",
      describeRoute({
        summary: "Start all autoStart processes",
        description:
          "Start all process configs that have autoStart=true. " +
          "Skips processes that are already running.",
        operationId: "process.startAll",
        responses: {
          200: {
            description: "All autoStart processes started",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await ProcessManager.startAll()
        return c.json(true)
      },
    )
    .post(
      "/stop-all",
      describeRoute({
        summary: "Stop all running processes",
        description: "Stop all currently running processes in reverse config order.",
        operationId: "process.stopAll",
        responses: {
          200: {
            description: "All processes stopped",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await ProcessManager.stopAll()
        return c.json(true)
      },
    )
    .get(
      "/diagnostics",
      describeRoute({
        summary: "Get process diagnostics",
        description:
          "Return managed process state, tracked PTYs, and OS-level processes spawned by OpenCode/Claxedo, " +
          "including memory and CPU usage plus stale/suspect classification.",
        operationId: "process.diagnostics",
        responses: {
          200: {
            description: "Diagnostics snapshot",
            content: {
              "application/json": {
                schema: resolver(Process.DiagnosticSnapshot),
              },
            },
          },
        },
      }),
      async (c) => {
        const snapshot = await collectDiagnostics({
          directory: c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd(),
          configs: ProcessManager.configs(),
          processes: ProcessManager.list(),
          ptys: Pty.list(),
        })
        return c.json(snapshot)
      },
    )
    .post(
      "/diagnostics/terminate",
      describeRoute({
        summary: "Terminate diagnostic target",
        description:
          "Terminate a managed process, tracked PTY, or raw OS process surfaced by process diagnostics.",
        operationId: "process.diagnostics.terminate",
        responses: {
          200: {
            description: "Target terminated",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Process.DiagnosticTerminateInput),
      async (c) => {
        const body = c.req.valid("json")
        if (body.process_id) {
          await ProcessManager.stop(body.process_id, body.signal)
          return c.json(true)
        }
        if (body.pty_id) {
          await Pty.remove(body.pty_id)
          return c.json(true)
        }
        await terminateDiagnostic(body)
        return c.json(true)
      },
    )
    .get(
      "/port-map",
      describeRoute({
        summary: "Get port map",
        description:
          "Returns a map of port name to assigned port number for all running portpick processes.",
        operationId: "process.portMap",
        responses: {
          200: {
            description: "Port name to port number map",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.number())),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(ProcessManager.portMap())
      },
    )
    .get(
      "/logs",
      describeRoute({
        summary: "Get process/terminal logs",
        description:
          "Read the PTY output buffer for a managed process or terminal session. " +
          "Accepts pty_id, terminal_id, process_id, or name to resolve the target PTY. " +
          "Returns the last N lines (default 100) as plain text.",
        operationId: "process.logs",
        responses: {
          200: {
            description: "Log output as plain text",
            content: { "text/plain": { schema: resolver(z.string()) } },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "query",
        z.object({
          pty_id: z.string().optional(),
          terminal_id: z.string().optional(),
          process_id: z.string().optional(),
          name: z.string().optional(),
          lines: z.coerce.number().int().min(1).max(10000).optional(),
        }),
      ),
      async (c) => {
        const { pty_id, terminal_id, process_id, name, lines: lineCount } = c.req.valid("query")
        const maxLines = lineCount ?? 100

        // Resolve to a pty ID
        let ptyId: string | undefined

        if (pty_id) {
          ptyId = pty_id
        } else if (terminal_id) {
          // terminal_id is treated as pty_id in Claxedo
          ptyId = terminal_id
        } else if (process_id) {
          const proc = ProcessManager.get(process_id)
          ptyId = proc?.ptyId
          if (!ptyId) {
            return c.json({ error: `Process ${process_id} not found or has no PTY` }, 404)
          }
        } else if (name) {
          const proc = ProcessManager.findByName(name)
          ptyId = proc?.ptyId
          if (!ptyId) {
            return c.json({ error: `Process named '${name}' not found or has no PTY` }, 404)
          }
        } else {
          return c.json({ error: "Provide one of: pty_id, terminal_id, process_id, name" }, 400)
        }

        const buffer = Pty.readBuffer(ptyId)
        if (buffer === undefined) {
          return c.json({ error: `PTY ${ptyId} not found` }, 404)
        }

        if (!buffer) {
          return c.text("")
        }

        const allLines = buffer.split("\n")
        const tail = allLines.slice(-maxLines)
        return c.text(tail.join("\n"))
      },
    ),
)
