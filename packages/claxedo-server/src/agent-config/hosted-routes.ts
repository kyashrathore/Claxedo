import { Hono, type Context } from "hono"
import { asRecord } from "@claxedo/helpers/guards"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"
import { userAgentConfigStore } from "@claxedo/server-core/agent-config/repository"
import {
  AgentConfigMutationError,
  connectionRows,
  deleteConnection,
  deleteMcpServer,
  parseHarnessSelection,
  putConnection,
  putMcpServer,
  setDefaultHarness,
} from "@claxedo/server-core/agent-config/mutations"
import { explicitDefaultHarness } from "@claxedo/server-core/agent-config/connections"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"

export function hostedAgentConfigRoutes(input: {
  services: ControlPlaneServices
  authentication: RequestAuthenticationAdapter
  repository: UserAgentConfigRepository
  changed(userId: string): Promise<void>
}) {
  const app = new Hono()
  const storeFor = async (c: Context) => {
    const result = await signedOrError(c.req.raw, { authentication: input.authentication, requireSigned: true }, input.services)
    if ("error" in result) return { response: c.json(result.error, result.status) }
    if (!result.auth) return { response: c.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, 401) }
    const person = asRecord(await requireAuthority(input.services).usersMe(result.auth))
    const userId = person?.user_id
    if (typeof userId !== "string" || !userId) throw new Error("workspace authority returned no user id")
    return { store: userAgentConfigStore(input.repository, userId), userId }
  }
  const mutation = async (c: Context, run: (scope: Awaited<ReturnType<typeof storeFor>> & { store: NonNullable<Awaited<ReturnType<typeof storeFor>>["store"]> }) => Promise<unknown>) => {
    try {
      const scope = await storeFor(c)
      if ("response" in scope) return scope.response
      const result = await run(scope as typeof scope & { store: NonNullable<typeof scope.store> })
      await input.changed(scope.userId)
      return c.json(result)
    } catch (error) {
      if (error instanceof AgentConfigMutationError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.status)
      }
      throw error
    }
  }
  return app
    .get("/connections", async (c) => {
      const scope = await storeFor(c)
      if ("response" in scope) return scope.response
      return c.json({ status: "supported", connections: connectionRows(await scope.store.read()) })
    })
    .put("/connections/:connectionId", (c) => mutation(c, async ({ store }) => ({
      ok: true,
      connections: await putConnection(store, c.req.param("connectionId"), await c.req.json()),
    })))
    .delete("/connections/:connectionId", (c) => mutation(c, async ({ store }) => {
      await deleteConnection(store, c.req.param("connectionId"))
      return { ok: true }
    }))
    .get("/mcp", async (c) => {
      const scope = await storeFor(c)
      if ("response" in scope) return scope.response
      return c.json((await scope.store.read()).mcp)
    })
    .post("/mcp/:name", (c) => mutation(c, async ({ store }) => {
      await putMcpServer(store, c.req.param("name"), await c.req.json())
      return { ok: true, name: c.req.param("name") }
    }))
    .delete("/mcp/:name", (c) => mutation(c, async ({ store }) => {
      await deleteMcpServer(store, c.req.param("name"))
      return { ok: true }
    }))
    .post("/harness", (c) => mutation(c, async ({ store }) => {
      const body = asRecord(await c.req.json())
      const selection = parseHarnessSelection(body?.harness)
      if (!selection) throw new AgentConfigMutationError("agent_config_harness_required", "A native harness or configured connection is required")
      if (body?.sessionId || c.req.query("sessionId")) {
        throw new AgentConfigMutationError("agent_config_harness_change_locked", "Session bindings are immutable; start a new session to use another agent connection", 409)
      }
      await setDefaultHarness(store, selection)
      return { ok: true, harness: selection, activeHarness: selection, status: "configured", ready: false }
    }))
    .get("/", async (c) => {
      const scope = await storeFor(c)
      if ("response" in scope) return scope.response
      const config = await scope.store.read()
      return c.json({ version: 4, mcp: config.mcp, connections: Object.values(config.connections),
        ...(explicitDefaultHarness(config) ? { defaultHarness: explicitDefaultHarness(config) } : {}) })
    })
}
