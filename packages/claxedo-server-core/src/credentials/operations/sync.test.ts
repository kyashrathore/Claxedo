import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Records rather than runs: collecting credentials must reach no command line
// at all, and an assertion on that has to be able to see an attempt.
const execFileSyncCalls: Array<{ file: string; args: readonly string[] }> = []
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>()
  const execFileSync = (file: string, args: readonly string[] = []) => {
    execFileSyncCalls.push({ file, args })
    throw new Error("no command line is available while collecting credentials")
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
const prevCursor = process.env.CURSOR_API_KEY
const prevOpenai = process.env.OPENAI_API_KEY
const prevXdgData = process.env.XDG_DATA_HOME
process.env.CLAXEDO_DATA_DIR = root
const userConfigFile = path.join(root, "user-agent-config.json")

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { putCredential, resolveSecret, deleteCredentialsByProvider, getCredentialByProvider } = await import("@claxedo/server-core/credentials/registry")
const { collectLocalCredentialItems, syncLocalCredentials } = await import("./sync")
const { credentialDiscovery } = await import("./discovery")
const { saveUserConfig } = await import("../../agent-config")
const { ClaxedoDB } = await import("../../platform/db")
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
    delete process.env.CURSOR_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.XDG_DATA_HOME
    execFileSyncCalls.length = 0
    await Promise.all([
      deleteCredentialsByProvider("claude-sdk"),
      deleteCredentialsByProvider("claude-sdk"),
      deleteCredentialsByProvider("codex-app-server"),
      deleteCredentialsByProvider("cursor-sdk"),
      deleteCredentialsByProvider("openai"),
      deleteCredentialsByProvider("daytona"),
      deleteCredentialsByProvider("modal"),
      deleteCredentialsByProvider("vercel"),
      deleteCredentialsByProvider("cloudflare"),
    ])
    // Removed rather than overwritten: `saveUserConfig` reads the file first,
    // so a test that left an unreadable one behind would fail every test after it.
    await fs.rm(userConfigFile, { force: true })
    await saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {}, sandbox_driver: {} })
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
    process.env.CURSOR_API_KEY = prevCursor
    process.env.OPENAI_API_KEY = prevOpenai
    process.env.XDG_DATA_HOME = prevXdgData
  })

  test("syncs env and local sandbox driver credentials into managed storage", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"
    process.env.MODAL_TOKEN_ID = "modal-id"
    process.env.MODAL_TOKEN_SECRET = "modal-secret"

    await saveUserConfig({ version: 3, connections: {},
      mcp: {},
      auth: { "claude-sdk": "sk-ant-config" },
      sandbox_driver: {
        auth: {
          modal: {
            token_id: "modal-config-id",
            token_secret: "modal-config-secret",
          },
        },
      },
    })

    const result = await syncLocalCredentials(["claude-sdk", "modal"])

    expect(result.synced).toEqual(["claude-sdk", "modal"])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("claude-sdk")).toBe("sk-ant-env")
    expect(await resolveSecret("modal")).toBe(JSON.stringify({
      token_id: "modal-id",
      token_secret: "modal-secret",
    }))
  })

  test("syncs Claude Code OAuth env credentials for the native SDK harness", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-env"

    const result = await syncLocalCredentials(["claude-sdk"])
    const sdk = JSON.parse(await resolveSecret("claude-sdk") ?? "{}") as Record<string, any>

    expect(result.synced).toEqual(["claude-sdk"])
    expect(result.existing).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.failed).toEqual([])
    expect((await getCredentialByProvider("claude-sdk"))?.source).toBe("env")
    expect((await getCredentialByProvider("claude-sdk"))?.label).toBe("Synced from CLAUDE_CODE_OAUTH_TOKEN")
    expect(sdk).toEqual({
      type: "claude_code_oauth",
      claudeAiOauth: { accessToken: "sk-ant-oat01-env" },
    })
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
      provider_id: "codex-app-server",
      kind: "api_key",
      source: "managed",
      secret: "sk-openai-managed",
    })

    const result = await syncLocalCredentials(["codex-app-server", "cursor-sdk"])

    expect(result.synced).toEqual([])
    expect(result.existing).toEqual(["codex-app-server"])
    expect(result.missing).toEqual(["cursor-sdk"])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("codex-app-server")).toBe("sk-openai-managed")
  })

  test("does not overwrite managed credentials with local or env sources", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env"

    await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-managed",
    })

    const result = await syncLocalCredentials(["claude-sdk"])

    expect(result.synced).toEqual([])
    expect(result.existing).toEqual(["claude-sdk"])
    expect(result.failed).toEqual([])
    expect(await resolveSecret("claude-sdk")).toBe("sk-ant-managed")
  })

  test("syncs Cursor credentials from the CURSOR_API_KEY env var", async () => {
    process.env.CURSOR_API_KEY = "cursor-env-key"

    const result = await syncLocalCredentials(["cursor-sdk"])

    expect(result.synced).toEqual(["cursor-sdk"])
    expect(result.missing).toEqual([])
    expect(await resolveSecret("cursor-sdk")).toBe("cursor-env-key")
    expect((await getCredentialByProvider("cursor-sdk"))?.source).toBe("env")
  })

  test("does not discover Cursor credentials from local Cursor state", async () => {
    // Deliberate: the IDE's state.vscdb only holds a cursor.com web-session
    // JWT, not a CURSOR_API_KEY, so local Cursor files must never sync.
    const home = process.env.HOME!
    for (const dir of [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage"),
      path.join(home, ".config", "Cursor", "User", "globalStorage"),
    ]) {
      mkdirSync(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "state.vscdb"), "fake-cursor-state-db")
    }
    mkdirSync(path.join(home, ".cursor"), { recursive: true })
    await fs.writeFile(path.join(home, ".cursor", "cli-config.json"), JSON.stringify({
      authInfo: { authId: "auth0|user_123" },
    }))

    const result = await syncLocalCredentials(["cursor-sdk"])

    expect(result.synced).toEqual([])
    expect(result.missing).toEqual(["cursor-sdk"])
    expect(await resolveSecret("cursor-sdk")).toBeNull()
  })

  test("an unreadable user agent config leaves every other source collectable", async () => {
    await fs.writeFile(userConfigFile, "{ not json")
    process.env.CURSOR_API_KEY = "cursor-env-key"
    process.env.OPENAI_API_KEY = "sk-openai-env"

    const discovered = await collectLocalCredentialItems()

    expect(discovered.map((item) => item.provider_id).toSorted((a, b) => a.localeCompare(b)))
      .toEqual(["codex-app-server", "cursor-sdk"])
  })

  test("a harness's own CLI login is never collected, from any of the places it is kept", async () => {
    const home = process.env.HOME!
    mkdirSync(path.join(home, ".claude"), { recursive: true })
    await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oauth-file", refreshToken: "refresh-file" },
    }))
    const accountsDir = path.join(home, ".codex", "accounts")
    mkdirSync(accountsDir, { recursive: true })
    const bundle = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-access", refresh_token: "codex-refresh", account_id: "acct-1" },
      last_refresh: "2026-04-01T00:00:00.000Z",
    })
    await fs.writeFile(path.join(home, ".codex", "auth.json"), bundle)
    await fs.writeFile(path.join(accountsDir, "someone@example.com.auth.json"), bundle)

    expect(await collectLocalCredentialItems()).toEqual([])
    expect(execFileSyncCalls).toEqual([])
  })

  test("the discovery route offers nothing on a machine whose only logins are its CLIs'", async () => {
    // The producer behind `POST /credentials/discover`, driven for real rather
    // than through a fixture: this is what the cloud onboarding step is handed
    // on a laptop that can run agents locally and has nothing to send anywhere.
    const home = process.env.HOME!
    mkdirSync(path.join(home, ".claude"), { recursive: true })
    await fs.writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oauth-file", refreshToken: "refresh-file" },
    }))
    mkdirSync(path.join(home, ".codex"), { recursive: true })
    await fs.writeFile(path.join(home, ".codex", "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "codex-access", refresh_token: "codex-refresh", account_id: "acct-1" },
      last_refresh: "2026-04-01T00:00:00.000Z",
    }))

    const discovery = await credentialDiscovery.discover()

    expect(discovery.items).toEqual([])
    expect(discovery.discovery_id).toEqual(expect.any(String))
  })
})

