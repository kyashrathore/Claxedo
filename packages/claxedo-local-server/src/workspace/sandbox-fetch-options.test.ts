import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"
import { sandboxFetchOptionsForRequest } from "./sandbox-fetch-options"

const authConfig = { enabled: true as const, issuer: "https://issuer.test", jwksUrl: "custom:test" }

const verifier = vi.fn(async (token: string) => ({
  mode: "signed" as const,
  user: { subject: token, issuer: "https://issuer.test", tokenIdentifier: `https://issuer.test|${token}` },
}))

const services = {
  localExecution: { enabled: true },
  sandbox: {},
  relay: {},
  authority: {
    usersMe: vi.fn(async () => ({ actor_id: "https://issuer.test|ada", actor_kind: "human", actor_public_id: "usr_ada", actor_name: "Ada" })),
    openWorkspace: vi.fn(async () => ({ allowed: true, role: "owner", workspace: { workspace_id: "ws_cloud", org_id: "org_1" } })),
  },
} as unknown as ControlPlaneServicesContract

function loopbackRequest(headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:4100/api/claxedo/agent-config/harness/options", { headers })
}

describe("sandboxFetchOptionsForRequest", () => {
  test("a signed caller on loopback reaches the runtime as that caller, carrying the auth its token is recorded under", async () => {
    const options = await sandboxFetchOptionsForRequest(loopbackRequest({ authorization: "Bearer ada" }), "ws_cloud", { services, authConfig, verifier })

    expect(options).toMatchObject({
      runtimeActor: { principalKind: "user", actorId: "https://issuer.test|ada", actorKind: "human" },
      auth: { mode: "signed", user: { subject: "ada" } },
      orgId: "org_1",
      role: "owner",
    })
  })

  test("an unsigned loopback request acts as the control-plane service", async () => {
    const options = await sandboxFetchOptionsForRequest(loopbackRequest(), "ws_cloud", { services, authConfig, verifier })

    expect(options).toMatchObject({ runtimeActor: { principalKind: "service", actorId: "control-plane" }, role: "owner" })
    expect(options.auth).toBeUndefined()
  })
})
