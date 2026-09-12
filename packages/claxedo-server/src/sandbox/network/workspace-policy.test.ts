import { afterAll, describe, expect, test } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `workspace-network-policy-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { putCredential } = await import("@claxedo/server-core/credentials/registry")
const { createPolicy } = await import("@claxedo/server-core/sandbox/network/policy")
const { ClaxedoDB } = await import("../../platform/db")
const { resolveWorkspaceSandboxNetworkPolicy } = await import("./workspace-policy")

setBackendOverride(createTestBackend())
ClaxedoDB.Drizzle()

async function sharedCredential(org: string, providerId: string) {
  await putCredential(
    {
      provider_id: providerId,
      kind: "oauth_token",
      source: "managed",
      scope: "shared",
      consent: { at: Date.now(), surface: "cli" },
      secret: `${providerId}-secret`,
    },
    org,
  )
}

describe("a workspace sandbox's egress policy", () => {
  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("stays unrestricted while the workspace has no policy row", async () => {
    await sharedCredential("org-open", "claude-sdk")

    expect(await resolveWorkspaceSandboxNetworkPolicy({ workspaceId: "ws-open", org: "org-open" })).toBeUndefined()
  })

  test("opens the hosts of every provider the fanout sends", async () => {
    createPolicy({ workspace_id: "ws-sends", target: "api.internal.test", kind: "host" })
    await sharedCredential("org-sends", "claude-sdk")

    const net = await resolveWorkspaceSandboxNetworkPolicy({ workspaceId: "ws-sends", org: "org-sends" })

    expect(net?.mode).toBe("restricted")
    expect(net?.hosts).toEqual(expect.arrayContaining(["api.internal.test", "*.anthropic.com", "claude.ai"]))
  })

  test("leaves a provider's hosts closed when the org stores no credential for it", async () => {
    createPolicy({ workspace_id: "ws-none", target: "api.internal.test", kind: "host" })

    const net = await resolveWorkspaceSandboxNetworkPolicy({ workspaceId: "ws-none", org: "org-none" })

    expect(net?.mode).toBe("restricted")
    expect(net?.hosts).toEqual(["127.0.0.1", "localhost", "api.internal.test"])
  })
})
