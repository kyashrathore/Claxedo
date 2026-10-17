import { afterEach, expect, test, vi } from "vitest"
import { createMemoryLeaseStore, sandboxLease } from "@claxedo/sandbox-manager/stores/memory"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { createHostedRuntimeDelivery } from "./hosted-runtime-delivery"
import { unusedWorkspaceIdleStop } from "../test-support/inline-sandbox-start"
import { hostedOrgCredentials, HOSTED_CREDENTIALS_FLAG } from "../credentials/worker"
import { orgRoutedCredentials } from "../credentials/worker/org-routed"
import { workspaceBackingDatabase } from "../test-support/workspace-backing-database"

type Input = Parameters<typeof createHostedRuntimeDelivery>[0]

const OWNERS: Record<string, string> = { "ws-a": "owner-A", "ws-b": "owner-B", "ws-a-edge": "owner-A" }
const BROKERING: Record<string, SandboxSecretBrokering> = { "ws-a": "none", "ws-b": "none", "ws-a-edge": "native" }

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function plane() {
  const database = await workspaceBackingDatabase(Object.keys(OWNERS).map((id) => ({ id, backing: "cloud-vm" as const })))
  disposals.push(() => database.dispose())
  const store = hostedOrgCredentials("org", { database: database.database, env: {
    [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64"),
  } }, { now: (() => { let at = 1_000; return () => ++at })() })
  const leaseStore = createMemoryLeaseStore(Object.keys(OWNERS).map((workspaceId) =>
    sandboxLease({ workspaceId, status: "ready", sandboxId: `sb-${workspaceId}`, hostId: `host-${workspaceId}`, url: "https://runtime.test", routingId: `route-${workspaceId}` })))
  const sandboxManager = { list: () => leaseStore.list(), target: async () => ({ status: "ready" }) } as unknown as Input["sandboxManager"]
  const refreshed: string[] = []
  const redelivered: string[] = []
  const delivery = createHostedRuntimeDelivery({
    sandboxRefresh: vi.fn(async (workspaceId: string) => {
      refreshed.push(workspaceId)
      return { status: "provisioning" as const, retryAfterMs: 1, epoch: 1, homeRegion: "us-east" }
    }),
    sandboxRedeliver: async (workspaceId) => void redelivered.push(workspaceId),
    idleStop: unusedWorkspaceIdleStop,
    authority: { resolveWorkspaceOwner: async (workspaceId: string) => ({ userId: OWNERS[workspaceId], orgId: "org" }) } as unknown as Input["authority"],
    database: database.database,
    services: {} as Input["services"],
    sandboxManager,
    workspaceSecretBrokering: async (workspaceId) => BROKERING[workspaceId],
    sandboxInput: async () => { throw new Error("this test provisions no sandbox") },
    settings: { read: async () => ({ version: 3, connections: {} }), write: async () => {} },
    credentials: () => store,
    signingEnv: {},
    provisionedRunner: undefined,
  })
  const credentials = orgRoutedCredentials(() => store, delivery.credentialChange)
  const touched = () => {
    const touches = { refreshed: [...refreshed].sort(), redelivered: [...redelivered].sort() }
    refreshed.length = 0
    redelivered.length = 0
    return touches
  }
  return { credentials, touched }
}

const NONE = { refreshed: [], redelivered: [] }

test("a write no running workspace spends touches none: an unmarked account on a host already held, an organization sandbox key, a source choice that keeps the account", async () => {
  const { credentials, touched } = await plane()
  await credentials.putCredential({ owner: "owner-A", provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner-a" }, "org")
  expect(touched()).toEqual({ refreshed: ["ws-a-edge"], redelivered: ["ws-a"] })

  await credentials.putCredential({ owner: "owner-A", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-bogus" }, "org")
  expect(touched()).toEqual(NONE)
  await credentials.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ api_key: "bx-org" }) }, "org")
  expect(touched()).toEqual(NONE)
  await credentials.setAccountSources(["openai"], "own", "org", "owner-B")
  expect(touched()).toEqual(NONE)
})

test("a write that changes an owner's delivered account reaches that owner's running workspaces alone: by a settings push where the plane brokers, through the driver where the edge holds accounts", async () => {
  const { credentials, touched } = await plane()
  await credentials.putCredential({ owner: "owner-B", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-owner-b" }, "org")
  expect(touched()).toEqual({ refreshed: [], redelivered: ["ws-b"] })

  const saved = await credentials.putCredential({ owner: "owner-B", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-owner-b-rotated" }, "org")
  expect(saved.revision).toBe(2)
  expect(touched()).toEqual({ refreshed: [], redelivered: ["ws-b"] })

  await credentials.setAccountSources(["openai"], "org", "org", "owner-B")
  expect(touched()).toEqual({ refreshed: [], redelivered: ["ws-b"] })

  await credentials.putCredential({ owner: "owner-A", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-owner-a" }, "org")
  expect(touched()).toEqual({ refreshed: ["ws-a-edge"], redelivered: ["ws-a"] })
})

test("a team key reaches only the running workspaces of people who chose the organization's account, and its removal takes it back from them alone by a settings push", async () => {
  const { credentials, touched } = await plane()
  await credentials.putCredential({ owner: null, provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-team-unchosen" }, "org")
  expect(touched()).toEqual(NONE)

  const team = await credentials.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team" }, "org")
  expect(touched()).toEqual(NONE)
  await credentials.setAccountSources(["claude-sdk", "claude-acp", "anthropic"], "org", "org", "owner-B")
  expect(touched()).toEqual({ refreshed: [], redelivered: ["ws-b"] })

  await credentials.deleteCredential(team.id, "org")
  expect(touched()).toEqual({ refreshed: [], redelivered: ["ws-b"] })
})
