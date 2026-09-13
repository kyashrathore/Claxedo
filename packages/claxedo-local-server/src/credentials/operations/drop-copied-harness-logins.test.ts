import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync, rmSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `drop-copied-logins-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const {
  deleteCredential,
  getCredential,
  listCredentials,
  putCredential,
  readSecretById,
} = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
const { dropCopiedHarnessLogins } = await import("./drop-copied-harness-logins")
ClaxedoDB.Drizzle()

const MARKER = path.join(root, "credentials", ".harness-logins-dropped")

beforeEach(async () => {
  setBackendOverride(createTestBackend())
  for (const row of listCredentials()) await deleteCredential(row.id)
  await fs.rm(MARKER, { force: true })
})

afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

function scanned(providerId: string, extra: { account_id?: string } = {}) {
  return putCredential({
    provider_id: providerId,
    kind: "oauth_token",
    source: "local_only",
    label: "Claude Code login · agent SDK",
    secret: JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-copied" } }),
    consent: { at: 1, surface: "desktop_discovery" },
    ...extra,
  })
}

describe("forgetting the harness logins an older Claxedo copied", () => {
  test("a scanned row the provider never named is deleted, secret and all", async () => {
    const copied = await scanned("claude-sdk")
    expect(await readSecretById(copied.id)).toContain("sk-ant-copied")

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 1 })

    expect(getCredential(copied.id)).toBeUndefined()
    expect(await readSecretById(copied.id)).toBeNull()
  })

  test("an account the provider did name, and a key the user typed, are left alone", async () => {
    const codex = await scanned("codex-app-server", { account_id: "acc_chatgpt" })
    const typed = await putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      label: "work key",
      secret: "sk-ant-typed",
      consent: { at: 1, surface: "api_key" },
    })

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 0 })

    expect(getCredential(codex.id)).toBeDefined()
    expect(getCredential(typed.id)).toBeDefined()
  })

  test("the mark moves to an account the user chose rather than being left nowhere", async () => {
    const copied = await scanned("claude-sdk")
    const typed = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      label: "work key",
      secret: "sk-ant-typed",
    })
    expect(getCredential(copied.id)?.is_active).toBe(true)

    await dropCopiedHarnessLogins()

    expect(getCredential(typed.id)?.is_active).toBe(true)
  })

  test("it runs once, so a login imported again on purpose is not reaped on the next boot", async () => {
    await scanned("claude-sdk")
    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 1 })

    const reimported = await scanned("claude-sdk")

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 0 })
    expect(getCredential(reimported.id)).toBeDefined()
  })
})
