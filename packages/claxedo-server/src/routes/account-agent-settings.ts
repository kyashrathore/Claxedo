import { Hono } from "hono"
import { z } from "zod"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"

export const ACCOUNT_AGENT_SETTINGS_PATH = "/api/account/agent-settings"

const putBody = z.object({ cross_machine_writes: z.boolean() }).strict()

/** "Agents may act on my other machines": whether an agent in a session may start tasks on new cloud machines. */
export type AgentSettings = Readonly<{ crossMachineWrites: boolean }>

export type AgentSettingsService = {
  read(userId: string): Promise<AgentSettings>
  write(userId: string, settings: AgentSettings): Promise<AgentSettings>
}

export type AccountAgentSettingsRouteOptions = {
  /** The deployment's own signed-request reader, already bound to its adapters. */
  signed(request: Request): Promise<{ auth?: SignedControlPlaneAuth } | { error: unknown; status: number }>
  service: AgentSettingsService
}

function wire(settings: AgentSettings) {
  return { cross_machine_writes: settings.crossMachineWrites }
}

/**
 * The row is keyed by the canonical user the authentication adapter resolved
 * the caller to, which is the same id `workspaces.owner_user_id` carries and
 * the same id a root capability is minted for — never a name from the body.
 */
async function caller(options: AccountAgentSettingsRouteOptions, request: Request): Promise<{ userId: string } | Response> {
  const result = await options.signed(request)
  if ("error" in result) return Response.json(result.error, { status: result.status })
  if (!result.auth) return Response.json({ error: { code: "UNAUTHORIZED", message: "Signed auth is required" } }, { status: 401 })
  const principal = result.auth.principal
  if (!principal || principal.actorKind !== "human") {
    return Response.json(
      { error: { code: "identity_provisioning", message: "Canonical application identity is required" } },
      { status: 503 },
    )
  }
  return { userId: principal.userId }
}

export function AccountAgentSettingsRoutes(options: AccountAgentSettingsRouteOptions) {
  const app = new Hono()

  app.get("/", async (c) => {
    const who = await caller(options, c.req.raw)
    if (!("userId" in who)) return who
    return c.json(wire(await options.service.read(who.userId)))
  })

  app.put("/", async (c) => {
    const who = await caller(options, c.req.raw)
    if (!("userId" in who)) return who
    const body = putBody.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) {
      return c.json({ error: { code: "agent_settings_invalid_body", message: "Invalid agent settings" } }, 400)
    }
    return c.json(wire(await options.service.write(who.userId, { crossMachineWrites: body.data.cross_machine_writes })))
  })

  return app
}

export function accountAgentSettingsRouteContribution(
  options: AccountAgentSettingsRouteOptions,
): ControlPlaneRouteContribution {
  return { id: "account-agent-settings", path: ACCOUNT_AGENT_SETTINGS_PATH, routes: AccountAgentSettingsRoutes(options) }
}
