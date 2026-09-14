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
  credentialById,
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

function scanned(providerId: string, kind: "oauth_token" | "api_key" = "oauth_token") {
  return putCredential({
    provider_id: providerId,
    kind,
    source: "local_only",
    label: "Claude Code login · agent SDK",
    secret: kind === "oauth_token"
      ? JSON.stringify({ type: "claude_code_oauth", claudeAiOauth: { accessToken: "sk-ant-copied" } })
      : "sk-ant-scanned-key",
    consent: { at: 1, surface: "desktop_discovery" },
  })
}

describe("forgetting the harness logins an older Claxedo copied", () => {
  test("a scanned row the provider never named is deleted, secret and all", async () => {
    const copied = await scanned("claude-sdk")
    expect(await readSecretById(copied.id)).toContain("sk-ant-copied")

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 1 })

    expect(credentialById(copied.id, { onOutage: "throw" })).toBeUndefined()
    expect(await readSecretById(copied.id)).toBeNull()
  })

  test("every harness binding a subscription token was copied into is reaped", async () => {
    const claude = await scanned("claude-sdk")
    const codex = await scanned("codex-app-server")

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 2 })

    expect(credentialById(claude.id, { onOutage: "throw" })).toBeUndefined()
    expect(credentialById(codex.id, { onOutage: "throw" })).toBeUndefined()
  })

  test("a scanned API key, a scanned vendor token, and a key the user typed are left alone", async () => {
    // The reaper takes harness logins. A key is material the user handed us on
    // purpose, and a vendor binding is an engine's provider rather than a
    // harness's own login — neither is a token a CLI rotates behind us.
    const scannedKey = await scanned("claude-sdk", "api_key")
    const vendorToken = await scanned("openrouter")
    const typed = await putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      label: "work key",
      secret: "sk-ant-typed",
      consent: { at: 1, surface: "api_key" },
    })

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 0 })

    expect(credentialById(scannedKey.id, { onOutage: "throw" })).toBeDefined()
    expect(credentialById(vendorToken.id, { onOutage: "throw" })).toBeDefined()
    expect(credentialById(typed.id, { onOutage: "throw" })).toBeDefined()
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
    expect(credentialById(copied.id, { onOutage: "throw" })?.is_active).toBe(true)

    await dropCopiedHarnessLogins()

    expect(credentialById(typed.id, { onOutage: "throw" })?.is_active).toBe(true)
  })

  test("it runs once, so a login imported again on purpose is not reaped on the next boot", async () => {
    await scanned("claude-sdk")
    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 1 })

    const reimported = await scanned("claude-sdk")

    expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 0 })
    expect(credentialById(reimported.id, { onOutage: "throw" })).toBeDefined()
  })

  test("a marker that cannot be written costs this boot's deletes rather than the next boot's rows", async () => {
    const copied = await scanned("claude-sdk")
    await fs.chmod(path.dirname(MARKER), 0o500)

    try {
      expect(await dropCopiedHarnessLogins()).toEqual({ dropped: 0 })
      expect(credentialById(copied.id, { onOutage: "throw" })).toBeDefined()
    } finally {
      await fs.chmod(path.dirname(MARKER), 0o700)
    }
  })
})
