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
import { Process } from "./process"
import * as ProcessManager from "./index"

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
    ),
)
