import { Hono, type Context as HonoContext, type MiddlewareHandler } from "hono"
import { streamSSE } from "hono/streaming"
import type { UpgradeWebSocket } from "hono/ws"
import { z } from "zod"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { boundedJsonBody, errorBody } from "@claxedo/session-core"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import type { HarnessServices, PluginProjection } from "@claxedo/harness/contract"
import { ownedShellExec } from "./owned-shell"
import { runFileSystemOperation } from "./execution-env-fs"
import { McpStdioRelayRoutes } from "./mcp-stdio-relay"

export type ExecutionEnvRouteOptions = {
  directory: string
  env: NodeJS.ProcessEnv
  spawn: HarnessServices["spawn"]
  piProjection: () => PluginProjection
  upgradeWebSocket: UpgradeWebSocket
}

type Env = { Variables: RelayHostAuthContext & { executionSessionId: string } }

const BODY_LIMIT_BYTES = 16 * 1024 * 1024
const fsRequest = z.object({ op: z.string(), args: z.array(z.unknown()) }).strict()

const execRequest = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inheritEnv: z.boolean().optional(),
  timeout: z.number().positive().optional(),
}).strict()

const executionEnvAccess: MiddlewareHandler<Env> = async (c, next) => {
  const claims = c.get("relayHostAuth")
  if (claims?.backing !== "cloud-vm") return c.json(errorBody("not_found", "Not found"), 404)
  if (!claims.session_id || claims.role === "viewer") {
    return c.json(errorBody("execution_env_forbidden", "The execution environment serves one session's editors"), 403)
  }
  c.set("executionSessionId", claims.session_id)
  return next()
}

async function parsed<T extends z.ZodType>(c: HonoContext, schema: T): Promise<z.output<T> | Response> {
  const body = schema.safeParse(await boundedJsonBody(c, { limit: BODY_LIMIT_BYTES }))
  return body.success ? body.data : c.json(errorBody("execution_env_request_invalid", z.prettifyError(body.error)), 400)
}

export function ExecutionEnvRoutes(options: ExecutionEnvRouteOptions) {
  const app = new Hono<Env>()
  app.use("*", executionEnvAccess)
  app.post("/fs", async (c) => {
    const request = await parsed(c, fsRequest)
    if (request instanceof Response) return request
    const result = await runFileSystemOperation(new NodeExecutionEnv({ cwd: options.directory }), request,
      withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT))
    return "invalid" in result ? c.json(errorBody("execution_env_request_invalid", result.invalid), 400) : c.json(result)
  })
  app.post("/exec", async (c) => {
    const request = await parsed(c, execRequest)
    if (request instanceof Response) return request
    const host = { spawn: options.spawn, sessionId: c.get("executionSessionId"), env: options.env }
    const context = withAbortSignal(c.req.raw.signal, BACKGROUND_CONTEXT)
    return streamSSE(c, async (stream) => {
      const { command, ...execOptions } = request
      const result = await ownedShellExec(host, options.directory, command, {
        ...execOptions, onOutput: (text) => { void stream.writeSSE({ event: "output", data: JSON.stringify({ text }) }) },
      }, context)
      await stream.writeSSE({ event: "result", data: JSON.stringify(result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { code: result.error.code, message: result.error.message } }) })
    })
  })
  app.route("/mcp", McpStdioRelayRoutes(options))
  return app
}
