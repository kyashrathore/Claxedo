import { describe, expect, test, vi } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  ACCOUNT_AGENT_SETTINGS_PATH,
  AccountAgentSettingsRoutes,
  accountAgentSettingsRouteContribution,
  type AgentSettings,
  type AgentSettingsService,
} from "./account-agent-settings"

function signedAs(userId: string | undefined): SignedControlPlaneAuth {
  return {
    mode: "signed",
    user: { subject: `subject-${userId ?? "nobody"}`, tokenIdentifier: "issuer|token", issuer: "https://issuer.test" },
    ...(userId
      ? {
          principal: {
            userId,
            actorId: `actor:${userId}`,
            actorKind: "human",
            deploymentId: "deployment-a",
            sessionId: "auth-session",
            authenticatedAt: 1,
            methods: [],
            assurance: "standard",
            client: { kind: "browser" },
            identity: { adapter: "better-auth", issuer: "https://issuer.test", subject: `subject-${userId}` },
          } as never,
        }
      : {}),
  }
}

function memoryService() {
  const rows = new Map<string, AgentSettings>()
  const read = vi.fn(async (userId: string) => rows.get(userId) ?? { crossMachineWrites: false })
  const write = vi.fn(async (userId: string, settings: AgentSettings) => {
    rows.set(userId, settings)
    return settings
  })
  const service: AgentSettingsService = { read, write }
  return { rows, service, read, write }
}

function app(input: { auth?: SignedControlPlaneAuth; refusal?: { error: unknown; status: number } }) {
  const { rows, service, read, write } = memoryService()
  const routes = AccountAgentSettingsRoutes({
    signed: async () => (input.refusal ? input.refusal : { auth: input.auth }),
    service,
  })
  return { routes, rows, read, write }
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("account agent settings routes", () => {
  test("refuses a request the signed reader refuses, with the reader's own answer", async () => {
    const { routes, read } = app({
      refusal: { error: { error: { code: "missing_bearer_token", message: "Authorization: Bearer token is required" } }, status: 401 },
    })
    const response = await routes.request("http://core.test/")
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: { code: "missing_bearer_token", message: "Authorization: Bearer token is required" },
    })
    expect(read).not.toHaveBeenCalled()
  })

  test("refuses an anonymous caller before reading anything", async () => {
    const { routes, read } = app({})
    const response = await routes.request("http://core.test/")
    expect(response.status).toBe(401)
    expect(read).not.toHaveBeenCalled()
  })

  test("a signed caller with no canonical identity is told so and writes nothing", async () => {
    const { routes, write } = app({ auth: signedAs(undefined) })
    const response = await routes.request("http://core.test/", put({ cross_machine_writes: true }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "identity_provisioning" } })
    expect(write).not.toHaveBeenCalled()
  })

  test("reads the caller's own row, off until they turn it on", async () => {
    const { routes, rows } = app({ auth: signedAs("user-a") })
    await expect((await routes.request("http://core.test/")).json()).resolves.toEqual({ cross_machine_writes: false })
    rows.set("user-a", { crossMachineWrites: true })
    rows.set("user-b", { crossMachineWrites: false })
    await expect((await routes.request("http://core.test/")).json()).resolves.toEqual({ cross_machine_writes: true })
  })

  test("writes the caller's own row and nobody else's, whatever the body names", async () => {
    const { routes, rows, write } = app({ auth: signedAs("user-a") })
    const response = await routes.request("http://core.test/", put({ cross_machine_writes: true }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ cross_machine_writes: true })
    expect(write).toHaveBeenCalledWith("user-a", { crossMachineWrites: true })
    expect(rows.get("user-a")).toEqual({ crossMachineWrites: true })

    const named = await routes.request("http://core.test/", put({ user_id: "user-b", cross_machine_writes: false }))
    expect(named.status).toBe(400)
    expect(rows.get("user-a")).toEqual({ crossMachineWrites: true })
    expect(rows.has("user-b")).toBe(false)
  })

  test("refuses a body that is not exactly one boolean", async () => {
    const { routes, write } = app({ auth: signedAs("user-a") })
    for (const body of [{}, { cross_machine_writes: "yes" }, { cross_machine_writes: 1 }, "true"]) {
      const response = await routes.request("http://core.test/", put(body))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "agent_settings_invalid_body" } })
    }
    expect(write).not.toHaveBeenCalled()
  })

  test("mounts as the account family's own route contribution", async () => {
    const { service } = memoryService()
    const contribution = accountAgentSettingsRouteContribution({
      signed: async () => ({ auth: signedAs("user-a") }),
      service,
    })
    expect(contribution.id).toBe("account-agent-settings")
    expect(contribution.path).toBe(ACCOUNT_AGENT_SETTINGS_PATH)
    expect(ACCOUNT_AGENT_SETTINGS_PATH).toBe("/api/account/agent-settings")
    await expect((await contribution.routes.request("http://core.test/")).json()).resolves.toEqual({ cross_machine_writes: false })
  })
})
