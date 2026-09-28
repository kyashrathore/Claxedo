import { expect, test, vi } from "vitest"
import { vercelBrokeredNetworkPolicy } from "@claxedo/sandbox-manager/drivers/vercel"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "../credentials/worker"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { miniflareControlPlaneDatabase, HOSTED_CREDENTIAL_MIGRATIONS } from "../test-support/control-plane-migrations"
import { hostedRuntimeConfigApply } from "./hosted-runtime-fetch"

vi.mock("./hosted-runtime-fetch", () => ({ hostedRuntimeConfigApply: vi.fn(async () => {}) }))

const OWNERS: Record<string, string> = { "ws-a": "A", "ws-b": "B" }

test("a workspace's sandbox is delivered its owner's account alone, and another person's placeholder buys no injection there", async () => {
  const database = await miniflareControlPlaneDatabase(HOSTED_CREDENTIAL_MIGRATIONS)
  try {
    const credentials = hostedOrgCredentials("org", { database: database.database, env: {
      [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
    } })
    for (const owner of ["A", "B"]) {
      await credentials.putCredential({ owner, provider_id: "openai", kind: "api_key", source: "managed", secret: `account-${owner}` })
    }
    type Input = Parameters<typeof createHostedRuntimeDelivery>[0]
    const delivery = createHostedRuntimeDelivery({
      authority: { resolveWorkspaceOwner: async (workspaceId: string) => ({ userId: OWNERS[workspaceId], orgId: "org" }) } as unknown as Input["authority"],
      services: {} as Input["services"], sandboxManager: {} as Input["sandboxManager"],
      driver: { metadata: { secretBrokering: "native" } } as Input["driver"],
      settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
      credentials: () => credentials, signingEnv: {},
    })
    const deliveredTo = async (workspaceId: string) => {
      const preparation = await delivery.prepareRuntime({ workspaceId })
      await delivery.provisionRuntime({ workspaceId }, preparation)
      return { secrets: preparation.secrets ?? [], snapshot: vi.mocked(hostedRuntimeConfigApply).mock.calls.at(-1)![2] }
    }
    const a = await deliveredTo("ws-a")
    const b = await deliveredTo("ws-b")

    expect(a.secrets.map((secret) => secret.value)).toEqual(["account-A"])
    expect(Object.keys(a.snapshot.auth.accounts)).toEqual(["A"])
    expect(JSON.stringify(a)).not.toContain("account-B")
    const bName = b.secrets[0].name
    expect(b.secrets.map((secret) => secret.value)).toEqual(["account-B"])
    expect(bName).not.toContain(Buffer.from("B").toString("hex").toUpperCase())
    expect(JSON.stringify(a)).not.toContain(bName)

    type Rule = { match?: { headers?: Array<{ value?: { exact?: string } }> } }
    const injectsInto = (secrets: typeof a.secrets, name: string) => {
      const policy = vercelBrokeredNetworkPolicy(secrets, undefined) as { allow?: Record<string, Rule[]> }
      return Object.values(policy.allow ?? {}).flat()
        .some((rule) => rule.match?.headers?.some((header) => header.value?.exact === `Bearer claxedo-broker:${name}`))
    }
    expect(injectsInto(a.secrets, bName)).toBe(false)
    expect(injectsInto(b.secrets, bName)).toBe(true)
  } finally { await database.dispose() }
})
