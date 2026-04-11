import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `cred-sync-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
const prevHome = process.env.HOME
const prevAnthropic = process.env.ANTHROPIC_API_KEY
const prevModalId = process.env.MODAL_TOKEN_ID
const prevModalSecret = process.env.MODAL_TOKEN_SECRET
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("./store")
const { putCredential, resolveSecret } = await import("./registry")
const { syncLocalCredentials } = await import("./sync")
const { saveUserConfig } = await import("../agent-config")
const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()

describe("syncLocalCredentials", () => {
  let backend: ReturnType<typeof createTestBackend>

  beforeEach(async () => {
    backend = createTestBackend()
    setBackendOverride(backend)
    process.env.HOME = path.join(root, "home")
    mkdirSync(process.env.HOME, { recursive: true })
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.MODAL_TOKEN_ID
    delete process.env.MODAL_TOKEN_SECRET
    await saveUserConfig({ mcp: {}, auth: {}, sandbox: {}, harness: {} })
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
    process.env.HOME = prevHome
    process.env.ANTHROPIC_API_KEY = prevAnthropic
    process.env.MODAL_TOKEN_ID = prevModalId
    process.env.MODAL_TOKEN_SECRET = prevModalSecret
  })

  test("syncs env and local sandbox credentials into managed storage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"
    process.env.MODAL_TOKEN_ID = "modal-id"
    process.env.MODAL_TOKEN_SECRET = "modal-secret"

    await saveUserConfig({
      mcp: {},
      auth: { "claude-acp": "sk-ant-config" },
      sandbox: {
        auth: {
          modal: {
            token_id: "modal-config-id",
            token_secret: "modal-config-secret",
          },
        },
      },
      harness: {},
    })

    const result = await syncLocalCredentials(["claude-acp", "modal"])

    expect(result.synced).toEqual(["claude-acp", "modal"])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("claude-acp")).toBe("sk-ant-env")
    expect(await resolveSecret("modal")).toBe(JSON.stringify({
      token_id: "modal-id",
      token_secret: "modal-secret",
    }))
  })

  test("reports existing managed credentials when no local source is present", async () => {
    await putCredential({
      provider_id: "codex-acp",
      kind: "api_key",
      source: "managed",
      secret: "sk-openai-managed",
    })

    const result = await syncLocalCredentials(["codex-acp", "cursor-acp"])

    expect(result.synced).toEqual([])
    expect(result.existing).toEqual(["codex-acp"])
    expect(result.missing).toEqual(["cursor-acp"])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("codex-acp")).toBe("sk-openai-managed")
  })

  test("syncs local Codex auth into managed storage", async () => {
    const dir = path.join(process.env.HOME!, ".codex")
    mkdirSync(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "id-token",
        access_token: "header.eyJleHAiOjE3OTAwMDAwMDB9.sig",
        refresh_token: "refresh-token",
        account_id: "acct-123",
      },
      last_refresh: "2026-04-11T00:00:00.000Z",
    }, null, 2))

    const result = await syncLocalCredentials(["codex-acp"])
    const raw = await resolveSecret("codex-acp")
    const secret = raw ? JSON.parse(raw) as Record<string, any> : undefined

    expect(result.synced).toEqual(["codex-acp"])
    expect(secret?.type).toBe("codex_auth")
    expect(secret?.tokens?.id_token).toBe("id-token")
    expect(secret?.oauth?.account_id).toBe("acct-123")
  })
})
