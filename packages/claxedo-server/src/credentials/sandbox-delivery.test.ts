import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `sandbox-delivery-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { deleteCredential, listCredentials, putCredential, setActiveCredentials } =
  await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
const { sandboxBrokeredSecrets } = await import("./sandbox-delivery")
ClaxedoDB.Drizzle()

const consent = { at: 1, surface: "desktop_discovery" } as const

/**
 * A backend that answers for every reference except the ones it is told to
 * refuse, which is what a locked keychain looks like to one account while the
 * rest of the store still reads.
 */
function backendRefusing(refused: () => Set<string>) {
  const inner = createTestBackend()
  return {
    ...inner,
    get: async (ref: string) => {
      if (refused().has(ref)) throw new Error("keychain is locked")
      return inner.get(ref)
    },
  }
}

const refused = new Set<string>()

async function shared(input: { provider_id: string; secret: string }) {
  return await putCredential({ kind: "api_key", source: "managed", scope: "shared", consent, ...input })
}

describe("the brokered secret set a cloud sandbox must hold", () => {
  beforeEach(async () => {
    setBackendOverride(backendRefusing(() => refused))
    refused.clear()
    for (const row of listCredentials()) await deleteCredential(row.id)
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("a deployment that states nothing and has no account says nothing at all", async () => {
    await expect(sandboxBrokeredSecrets({})).resolves.toEqual({})
  })

  test("a driver that cannot broker is told only what the caller stated", async () => {
    const credential = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    setActiveCredentials([credential.id])

    const plan = await sandboxBrokeredSecrets({
      stated: [{ name: "REPO_TOKEN", value: "ghp_1", hosts: ["github.com"] }],
      secretBrokering: "none",
    })

    expect(plan).toEqual({ secrets: [{ name: "REPO_TOKEN", value: "ghp_1", hosts: ["github.com"] }] })
  })

  test("an unreadable account holds the installed set rather than withdrawing it", async () => {
    const claude = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    const openai = await shared({ provider_id: "openai", secret: "sk-openai-one" })
    setActiveCredentials([claude.id, openai.id])
    const installed = (await sandboxBrokeredSecrets({ installed: undefined })).digest
    expect(installed).toBeDefined()

    refused.add(readRef(claude.id))
    const plan = await sandboxBrokeredSecrets({ installed })

    expect(plan).toEqual({ digest: installed })
  })

  test("an account withdrawn while another is unreadable is still withdrawn", async () => {
    // Otherwise a revoked account stays installed at the provider edge for as
    // long as the other account's secret backend stays down.
    const claude = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    const openai = await shared({ provider_id: "openai", secret: "sk-openai-one" })
    setActiveCredentials([claude.id, openai.id])
    const installed = (await sandboxBrokeredSecrets({})).digest
    expect(installed).toBeDefined()

    await deleteCredential(openai.id)
    refused.add(readRef(claude.id))
    const plan = await sandboxBrokeredSecrets({ installed })

    expect(plan.secrets).toEqual([])
    expect(plan.digest).not.toBe(installed)
  })

  test("an account switched while another is unreadable reaches the edge as the new one", async () => {
    const claude = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    const openai = await shared({ provider_id: "openai", secret: "sk-openai-one" })
    setActiveCredentials([claude.id, openai.id])
    const installed = (await sandboxBrokeredSecrets({})).digest

    const replacement = await shared({ provider_id: "openai", secret: "sk-openai-two" })
    setActiveCredentials([replacement.id])
    refused.add(readRef(claude.id))
    const plan = await sandboxBrokeredSecrets({ installed })

    expect(plan.secrets?.map((row) => row.value)).toEqual(["sk-openai-two"])
    expect(plan.digest).not.toBe(installed)
  })

  test("a delivered secret carries the methods and paths its provider edge is configured from", async () => {
    // The Cloudflare Worker answers 403 and Vercel writes no transform when a
    // registration arrives with neither, so an omitted list is a refusal rather
    // than an absence of restriction.
    const credential = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    setActiveCredentials([credential.id])

    const plan = await sandboxBrokeredSecrets({})

    expect(plan.secrets).toEqual([expect.objectContaining({
      name: "CLAXEDO_PROVIDER_CLAUDE_SDK",
      hosts: ["api.anthropic.com"],
      header: "x-api-key",
      methods: ["POST", "GET"],
      pathPrefixes: ["/v1/messages", "/v1/models"],
    })])
  })

  test("a caller's own secret name cannot be claimed by a provider account", async () => {
    const credential = await shared({ provider_id: "claude-sdk", secret: "sk-ant-api03-one" })
    setActiveCredentials([credential.id])

    await expect(sandboxBrokeredSecrets({
      stated: [{ name: "CLAXEDO_PROVIDER_CLAUDE_SDK", value: "other", hosts: ["api.anthropic.com"] }],
    })).rejects.toThrow(/claimed by both/)
  })
})

function readRef(id: string) {
  const row = listCredentials().find((item) => item.id === id)
  if (!row?.secure_ref) throw new Error(`credential ${id} has no stored reference`)
  return row.secure_ref
}
