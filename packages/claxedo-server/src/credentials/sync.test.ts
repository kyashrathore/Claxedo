import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Keychain lookups must fail in tests so the macOS dev machine's real
// Claude Code credentials never leak into assertions.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  const execFileSync = () => {
    throw new Error("keychain unavailable in tests")
  }
  return { ...actual, default: { ...actual, execFileSync }, execFileSync }
})

const root = path.join(realpathSync(os.tmpdir()), `cred-sync-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
const prevHome = process.env.HOME
const prevAnthropic = process.env.ANTHROPIC_API_KEY
const prevClaudeOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN
const prevAnthropicAuth = process.env.ANTHROPIC_AUTH_TOKEN
const prevModalId = process.env.MODAL_TOKEN_ID
const prevModalSecret = process.env.MODAL_TOKEN_SECRET
const prevVercelToken = process.env.VERCEL_TOKEN
const prevVercelTeam = process.env.VERCEL_TEAM_ID
const prevVercelProject = process.env.VERCEL_PROJECT_ID
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("./store")
const { putCredential, resolveSecret, deleteCredentialsByProvider, getCredentialByProvider } = await import("./registry")
const { collectLocalCredentialItems, syncLocalCredentials } = await import("./sync")
const { saveUserConfig } = await import("../agent-config")
const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()

describe("syncLocalCredentials", () => {
  let backend: ReturnType<typeof createTestBackend>

  beforeEach(async () => {
    backend = createTestBackend()
    setBackendOverride(backend)
    process.env.HOME = path.join(root, "home")
    await fs.rm(process.env.HOME, { recursive: true, force: true })
    mkdirSync(process.env.HOME, { recursive: true })
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.MODAL_TOKEN_ID
    delete process.env.MODAL_TOKEN_SECRET
    delete process.env.VERCEL_TOKEN
    delete process.env.VERCEL_TEAM_ID
    delete process.env.VERCEL_PROJECT_ID
    await Promise.all([
      deleteCredentialsByProvider("claude-acp"),
      deleteCredentialsByProvider("claude-sdk"),
      deleteCredentialsByProvider("codex-acp"),
      deleteCredentialsByProvider("cursor-acp"),
      deleteCredentialsByProvider("openai"),
      deleteCredentialsByProvider("daytona"),
      deleteCredentialsByProvider("modal"),
      deleteCredentialsByProvider("vercel"),
      deleteCredentialsByProvider("cloudflare"),
    ])
    await saveUserConfig({ mcp: {}, auth: {}, sandbox_driver: {} })
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
    process.env.HOME = prevHome
    process.env.ANTHROPIC_API_KEY = prevAnthropic
    process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeOAuth
    process.env.ANTHROPIC_AUTH_TOKEN = prevAnthropicAuth
    process.env.MODAL_TOKEN_ID = prevModalId
    process.env.MODAL_TOKEN_SECRET = prevModalSecret
    process.env.VERCEL_TOKEN = prevVercelToken
    process.env.VERCEL_TEAM_ID = prevVercelTeam
    process.env.VERCEL_PROJECT_ID = prevVercelProject
  })

  test("syncs env and local sandbox driver credentials into managed storage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"
    process.env.MODAL_TOKEN_ID = "modal-id"
    process.env.MODAL_TOKEN_SECRET = "modal-secret"

    await saveUserConfig({
      mcp: {},
      auth: { "claude-acp": "sk-ant-config" },
      sandbox_driver: {
        auth: {
          modal: {
            token_id: "modal-config-id",
            token_secret: "modal-config-secret",
          },
        },
      },
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

  test("syncs Claude Code OAuth env credentials for ACP and SDK harnesses", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oauth-env",
      },
    })

    const result = await syncLocalCredentials(["claude-acp", "claude-sdk"])
    const acp = JSON.parse(await resolveSecret("claude-acp") ?? "{}") as Record<string, any>
    const sdk = JSON.parse(await resolveSecret("claude-sdk") ?? "{}") as Record<string, any>

    expect(result.synced).toEqual(["claude-acp", "claude-sdk"])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect((await getCredentialByProvider("claude-acp"))?.source).toBe("managed")
    expect((await getCredentialByProvider("claude-sdk"))?.source).toBe("managed")
    expect(acp).toEqual({
      type: "claude_code_oauth",
      claudeAiOauth: { accessToken: "sk-ant-oauth-env" },
    })
    expect(sdk).toEqual(acp)
  })

  test("falls back to Claude Code credentials file when env and keychain are unavailable", async () => {
    const dir = path.join(process.env.HOME!, ".claude")
    mkdirSync(dir, { recursive: true })
    await fs.writeFile(path.join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oauth-file",
        refreshToken: "refresh-file",
        expiresAt: 1_790_000_000_000,
      },
    }))

    const result = await syncLocalCredentials(["claude-acp", "claude-sdk"])
    const acp = JSON.parse(await resolveSecret("claude-acp") ?? "{}") as Record<string, any>

    expect(result.synced).toEqual(["claude-acp", "claude-sdk"])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect(acp).toEqual({
      type: "claude_code_oauth",
      claudeAiOauth: { accessToken: "sk-ant-oauth-file" },
    })
    expect(await resolveSecret("claude-sdk")).toBe(await resolveSecret("claude-acp"))
    expect((await getCredentialByProvider("claude-acp"))?.label).toBe("Synced from local Claude Code login")
  })

  test("syncs complete Vercel sandbox driver credentials as structured managed secret", async () => {
    process.env.VERCEL_TOKEN = "vercel-token"
    process.env.VERCEL_TEAM_ID = "team-id"
    process.env.VERCEL_PROJECT_ID = "project-id"

    const result = await syncLocalCredentials(["vercel"])

    expect(result.synced).toEqual(["vercel"])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("vercel")).toBe(JSON.stringify({
      access_token: "vercel-token",
      team_id: "team-id",
      project_id: "project-id",
    }))
  })

  test("does not report Vercel sandbox driver credentials when team or project is missing", async () => {
    process.env.VERCEL_TOKEN = "vercel-token"
    process.env.VERCEL_TEAM_ID = "team-id"

    const result = await syncLocalCredentials(["vercel"])

    expect(result.synced).toEqual([])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual(["vercel"])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("vercel")).toBeNull()
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

  test("does not overwrite managed credentials with local or env sources", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"

    await putCredential({
      provider_id: "claude-acp",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-managed",
    })

    const result = await syncLocalCredentials(["claude-acp"])

    expect(result.synced).toEqual([])
    expect(result.existing).toEqual(["claude-acp"])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("claude-acp")).toBe("sk-ant-managed")
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

  test("syncs local OpenCode oauth auth into managed openai storage", async () => {
    const dir = path.join(process.env.HOME!, ".local", "share", "opencode")
    mkdirSync(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
      openai: {
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: 1_790_000_000_000,
        accountId: "acct-openai",
      },
    }, null, 2))

    const result = await syncLocalCredentials(["openai"])
    const raw = await resolveSecret("openai")
    const secret = raw ? JSON.parse(raw) as Record<string, unknown> : undefined

    expect(result.synced).toEqual(["openai"])
    expect(secret).toEqual({
      type: "oauth",
      refresh: "refresh-openai",
      access: "access-openai",
      expires: 1_790_000_000_000,
      accountId: "acct-openai",
    })
  })

  test("prefers freshest codex account auth over stale top-level auth", async () => {
    const codexDir = path.join(process.env.HOME!, ".codex")
    const accountsDir = path.join(codexDir, "accounts")
    mkdirSync(accountsDir, { recursive: true })
    await fs.writeFile(path.join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        account_id: "stale-account",
      },
      last_refresh: "2026-04-01T00:00:00.000Z",
    }, null, 2))
    await fs.writeFile(path.join(accountsDir, "fresh.auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fresh-id",
        access_token: "header.eyJleHAiOjE3OTAwMDAwMDB9.sig",
        refresh_token: "fresh-refresh",
        account_id: "fresh-account",
      },
      last_refresh: "2026-04-22T00:00:00.000Z",
    }, null, 2))

    const result = await syncLocalCredentials(["codex-acp"])
    const raw = await resolveSecret("codex-acp")
    const secret = raw ? JSON.parse(raw) as Record<string, any> : undefined

    expect(result.synced).toEqual(["codex-acp"])
    expect(secret?.tokens?.account_id).toBe("fresh-account")
    expect(secret?.tokens?.id_token).toBe("fresh-id")
  })

  test("discovers every local Codex account without exposing account names in origins", async () => {
    const accountsDir = path.join(process.env.HOME!, ".codex", "accounts")
    mkdirSync(accountsDir, { recursive: true })
    await Promise.all([
      ["first@example.com.auth.json", "first-account", "2026-04-22T00:00:00.000Z"],
      ["second@example.com.auth.json", "second-account", "2026-04-21T00:00:00.000Z"],
    ].map(([file, account, refreshed]) => fs.writeFile(path.join(accountsDir, file!), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `access-${account}`,
        refresh_token: `refresh-${account}`,
        account_id: account,
      },
      last_refresh: refreshed,
    }))))

    const discovered = (await collectLocalCredentialItems())
      .filter((item) => item.provider_id === "codex-acp")

    expect(discovered.map((item) => item.account_id)).toEqual(["first-account", "second-account"])
    expect(discovered.map((item) => item.origin)).toEqual([
      "~/.codex/accounts/*.auth.json",
      "~/.codex/accounts/*.auth.json",
    ])
  })
})
