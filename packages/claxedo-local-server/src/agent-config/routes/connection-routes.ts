import { Hono } from "hono"
import { loadUserConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import {
  AgentConfigMutationError,
  connectionRows,
  deleteConnection,
  putConnection,
} from "@claxedo/server-core/agent-config/mutations"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { fanOutConfig } from "../fanout"
import { localAgentConfigAllowed } from "../local-auth"
import type { AgentConfigRouteOptions } from "../route-options"

const store = { read: loadUserConfig, write: saveUserConfig }

export function agentConfigConnectionRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/connections", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      return c.json({ status: "supported" as const, connections: connectionRows(await store.read()) })
    })
    .put("/connections/:connectionId", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      try {
        const connections = await putConnection(store, c.req.param("connectionId"), await c.req.json())
        await fanOutConfig()
        return c.json({ ok: true, connections })
      } catch (error) {
        if (error instanceof AgentConfigMutationError) return c.json(errorBody(error.code, error.message), error.status)
        throw error
      }
    })
    .delete("/connections/:connectionId", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local agent connections",
      })
      if (localOnly) return localOnly
      try {
        await deleteConnection(store, c.req.param("connectionId"))
        await fanOutConfig()
        return c.json({ ok: true })
      } catch (error) {
        if (error instanceof AgentConfigMutationError) return c.json(errorBody(error.code, error.message), error.status)
        throw error
      }
    })
}
