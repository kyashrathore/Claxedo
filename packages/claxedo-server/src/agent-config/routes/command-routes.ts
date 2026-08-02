import { Hono } from "hono"
import { deleteCommand, getCommand, listCommands, saveCommand } from "../../agent-config"
import { errorBody } from "../../routes/http"
import { localAgentConfigAllowed } from "./local-auth"
import type { AgentConfigRouteOptions } from "./extension-support"

export function agentConfigCommandRoutes(options: AgentConfigRouteOptions = {}) {
  return new Hono()
    .get("/commands", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local command config",
      })
      if (localOnly) return localOnly
      const commands = await listCommands()
      return c.json(commands)
    })

    .get("/commands/:name", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local command config",
      })
      if (localOnly) return localOnly
      const cmd = await getCommand(c.req.param("name"))
      if (!cmd) return c.json(errorBody("agent_config_command_not_found", "Command not found"), 404)
      return c.json(cmd)
    })

    .post("/commands", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local command config",
      })
      if (localOnly) return localOnly
      const body = await c.req.json<{ name?: string; content?: string }>().catch(() => null)
      if (!body || !body.name || !body.content) {
        return c.json(errorBody("agent_config_command_invalid_body", "name and content are required"), 400)
      }
      const saved = await saveCommand(body.name, body.content)
      return c.json({ ok: true, name: saved }, 201)
    })

    .delete("/commands/:name", async (c) => {
      const localOnly = await localAgentConfigAllowed({
        request: c.req.raw,
        authConfig: options.authConfig,
        verifier: options.verifier,
        label: "Local command config",
      })
      if (localOnly) return localOnly
      const deleted = await deleteCommand(c.req.param("name"))
      if (!deleted) return c.json(errorBody("agent_config_command_not_found", "Command not found"), 404)
      return c.json({ ok: true })
    })
}
