import { expect, test, vi } from "vitest"
import { vercelBrokeredNetworkPolicy } from "@claxedo/sandbox-manager/drivers/vercel"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedSandboxStart } from "../test-support/inline-sandbox-start"
import { hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "../credentials/worker"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"

const configApplied = vi.hoisted(() => vi.fn(async (_snapshot: import("@claxedo/workspace-runtime/config").RuntimeSnapshot) => {}))
vi.mock("@claxedo/workspace-runtime/client", () => ({ createWorkspaceRuntimeClient: vi.fn(() => ({ applyConfig: configApplied })) }))
vi.mock("@claxedo/server-core/platform/auth/runtime-access-token", () => ({ mintSupervisorBackplaneToken: vi.fn(async () => ({ supervisorBackplaneToken: "supervisor-token" })) }))

const OWNERS: Record<string, string> = { "ws-a": "owner-A", "ws-b": "owner-B" }

test("a workspace's sandbox is delivered its owner's account alone, and another person's placeholder buys no injection there", async () => {
  const database = await workspaceBackingDatabase([{ id: "ws-a", backing: "cloud-vm" }, { id: "ws-b", backing: "cloud-vm" }])
  try {
    const credentials = hostedOrgCredentials("org", { database: database.database, env: {
      [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
    } })
    for (const owner of Object.values(OWNERS)) {
      await credentials.putCredential({ owner, provider_id: "openai", kind: "api_key", source: "managed", secret: `account-${owner}` })
    }
    type Input = Parameters<typeof createHostedRuntimeDelivery>[0]
    const delivery = createHostedRuntimeDelivery({
      sandboxRefresh: unusedSandboxStart,
      authority: { resolveWorkspaceOwner: async (workspaceId: string) => ({ userId: OWNERS[workspaceId], orgId: "org" }) } as unknown as Input["authority"],
      database: database.database,
      services: { sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host", url: "https://runtime.test" }) } } } as unknown as Input["services"], sandboxManager: {} as Input["sandboxManager"],
      workspaceSecretBrokering: async () => "native",
      sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
      settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
      credentials: () => credentials, signingEnv: {}, provisionedRunner: undefined,
    })
    const deliveredTo = async (workspaceId: string) => {
      const preparation = await delivery.prepareRuntime({ workspaceId })
      await delivery.provisionRuntime({ workspaceId }, preparation)
      return { secrets: preparation.secrets ?? [], snapshot: configApplied.mock.calls.at(-1)![0] }
    }
    const a = await deliveredTo("ws-a")
    const b = await deliveredTo("ws-b")

    expect(a.secrets.map((secret) => secret.value)).toEqual(["account-owner-A"])
    expect(Object.keys(a.snapshot.auth.accounts)).toEqual([OWNERS["ws-a"]])
    expect(JSON.stringify(a)).not.toContain("account-owner-B")
    const bName = b.secrets[0].name
    expect(b.secrets.map((secret) => secret.value)).toEqual(["account-owner-B"])
    expect(bName).not.toContain(OWNERS["ws-b"])
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

test("a key saved for Pi never moves Claude Code off its Anthropic login; only choosing the key does", async () => {
  const database = await workspaceBackingDatabase([{ id: "ws-a", backing: "cloud-vm" }])
  try {
    let at = 1_000
    const credentials = hostedOrgCredentials("org", { database: database.database, env: {
      [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64"),
    } }, { now: () => ++at })
    const owner = OWNERS["ws-a"]
    const token = await credentials.putCredential({ owner, provider_id: "claude-sdk", kind: "oauth_token", source: "managed", secret: "sk-ant-oat01-token" })
    type Input = Parameters<typeof createHostedRuntimeDelivery>[0]
    const delivery = createHostedRuntimeDelivery({
      sandboxRefresh: unusedSandboxStart,
      authority: { resolveWorkspaceOwner: async () => ({ userId: owner, orgId: "org", projectId: "project" }) } as unknown as Input["authority"],
      database: database.database,
      services: {} as Input["services"], sandboxManager: {} as Input["sandboxManager"],
      workspaceSecretBrokering: async () => "native",
      sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
      settings: { read: async () => ({ version: 3, connections: {}, sandbox_driver: {} }), write: async () => {} },
      credentials: () => credentials, signingEnv: {}, provisionedRunner: undefined,
    })
    const delivered = async () => ((await delivery.prepareRuntime({ workspaceId: "ws-a" })).secrets ?? []).map((secret) => secret.value)

    expect(await delivered()).toEqual(["sk-ant-oat01-token"])
    const key = await credentials.putCredential({ owner, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-key" })
    expect(await delivered()).toEqual(["sk-ant-oat01-token"])
    await credentials.putCredential({ owner, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-key-2" })
    expect(await delivered()).toEqual(["sk-ant-oat01-token"])
    expect(await credentials.setActiveCredentials?.([key.id], "org", owner)).toMatchObject({ ok: true })
    expect(await delivered()).toEqual(["sk-ant-api03-key-2"])
    expect(await credentials.setActiveCredentials?.([token.id], "org", owner)).toMatchObject({ ok: true })
    expect(await delivered()).toEqual(["sk-ant-oat01-token"])
  } finally { await database.dispose() }
})
