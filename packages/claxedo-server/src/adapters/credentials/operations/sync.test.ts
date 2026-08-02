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
const prevCursor = process.env.CURSOR_API_KEY
const prevXdgData = process.env.XDG_DATA_HOME
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../store")
const { putCredential, resolveSecret, deleteCredentialsByProvider, getCredentialByProvider } = await import("../registry")
const { collectLocalCredentialItems, syncLocalCredentials } = await import("./sync")
const { saveUserConfig } = await import("../../../agent-config")
const { ClaxedoDB } = await import("../../../platform/db/db")
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
    delete process.env.XDG_DATA_HOME
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
    process.env.CURSOR_API_KEY = prevCursor
    process.env.XDG_DATA_HOME = prevXdgData
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
    // `claude-acp` and `claude-sdk` are two bindings of ONE credential, so the
    // label has to name the binding — two rows reading "Synced from local Claude
    // Code login" asked the user to choose between things they couldn't tell
    // apart.
    expect((await getCredentialByProvider("claude-acp"))?.label).toBe("Claude Code login · ACP adapter")
    expect((await getCredentialByProvider("claude-sdk"))?.label).toBe("Claude Code login · agent SDK")
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

  test("prefers OpenCode auth under XDG_DATA_HOME over the default data dir", async () => {
    process.env.XDG_DATA_HOME = path.join(process.env.HOME!, "xdg-data")
    const xdgDir = path.join(process.env.XDG_DATA_HOME, "opencode")
    const defaultDir = path.join(process.env.HOME!, ".local", "share", "opencode")
    mkdirSync(xdgDir, { recursive: true })
    mkdirSync(defaultDir, { recursive: true })
    await fs.writeFile(path.join(xdgDir, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "sk-openai-xdg" },
    }))
    await fs.writeFile(path.join(defaultDir, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "sk-openai-default" },
    }))

    const result = await syncLocalCredentials(["openai"])

    expect(result.synced).toEqual(["openai"])
    expect(await resolveSecret("openai")).toBe("sk-openai-xdg")
  })

  test("discovers OpenCode auth via os.homedir when HOME is unset (Windows-style home)", async () => {
    const home = process.env.HOME!
    delete process.env.HOME
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(home)
    try {
      const dir = path.join(home, ".local", "share", "opencode")
      mkdirSync(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
        openai: { type: "api", key: "sk-openai-userprofile" },
      }))

      const result = await syncLocalCredentials(["openai"])

      expect(result.synced).toEqual(["openai"])
      expect(await resolveSecret("openai")).toBe("sk-openai-userprofile")
    } finally {
      homedirSpy.mockRestore()
      process.env.HOME = home
    }
  })

  test("syncs Cursor credentials from the CURSOR_API_KEY env var", async () => {
    process.env.CURSOR_API_KEY = "cursor-env-key"

    const result = await syncLocalCredentials(["cursor-acp"])

    expect(result.synced).toEqual(["cursor-acp"])
    expect(result.missing).toEqual([])
    expect(await resolveSecret("cursor-acp")).toBe("cursor-env-key")
    expect((await getCredentialByProvider("cursor-acp"))?.source).toBe("env")
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

    const result = await syncLocalCredentials(["cursor-acp"])

    expect(result.synced).toEqual([])
    expect(result.missing).toEqual(["cursor-acp"])
    expect(await resolveSecret("cursor-acp")).toBeNull()
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

  // Both files can hold the SAME account with different tokens — the CLI
  // refreshes whichever copy it is using. Importing the accounts-dir copy
  // wholesale meant picking a months-old token that the provider had already
  // revoked, while a token refreshed yesterday sat in auth.json.
  test("prefers the freshest copy of an account across auth.json and the accounts dir", async () => {
    const codexDir = path.join(process.env.HOME!, ".codex")
    const accountsDir = path.join(codexDir, "accounts")
    mkdirSync(accountsDir, { recursive: true })
    await fs.writeFile(path.join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "renewed-access",
        refresh_token: "renewed-refresh",
        account_id: "shared-account",
      },
      last_refresh: "2026-07-24T00:00:00.000Z",
    }))
    await fs.writeFile(path.join(accountsDir, "shared@example.com.auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        account_id: "shared-account",
      },
      last_refresh: "2026-06-02T00:00:00.000Z",
    }))

    const discovered = (await collectLocalCredentialItems())
      .filter((item) => item.provider_id === "codex-acp")

    expect(discovered).toHaveLength(1)
    expect(discovered[0]!.account_id).toBe("shared-account")
    expect(discovered[0]!.origin).toBe("~/.codex/auth.json")
    expect(JSON.parse(discovered[0]!.secret).access).toBe("renewed-access")
  })

  test("still lists a top-level account that has no accounts-dir copy", async () => {
    const codexDir = path.join(process.env.HOME!, ".codex")
    const accountsDir = path.join(codexDir, "accounts")
    mkdirSync(accountsDir, { recursive: true })
    await fs.writeFile(path.join(codexDir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "solo-access", refresh_token: "solo-refresh", account_id: "solo-account" },
      last_refresh: "2026-04-01T00:00:00.000Z",
    }))
    await fs.writeFile(path.join(accountsDir, "other@example.com.auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "other-access", refresh_token: "other-refresh", account_id: "other-account" },
      last_refresh: "2026-04-22T00:00:00.000Z",
    }))

    const discovered = (await collectLocalCredentialItems())
      .filter((item) => item.provider_id === "codex-acp")

    expect(discovered.map((item) => item.account_id).sort()).toEqual(["other-account", "solo-account"])
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

  /**
   * The Keychain item is not ours and is not only ours: `Claude Code-credentials`
   * holds the user's Claude login next to an `mcpOAuth` map of access tokens
   * belonging to unrelated third-party MCP servers, and Claude Code rewrites the
   * item on its own schedule. Both halves of that — read only our field, and
   * only when the user asked — are pinned here.
   */
  describe("the macOS Keychain", () => {
    const KEYCHAIN_BLOB = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-keychain",
        refreshToken: "refresh-keychain",
        expiresAt: 1_790_000_000_000,
      },
      mcpOAuth: {
        "posthog-mcp": {
          accessToken: "phx-third-party-access",
          refreshToken: "phx-third-party-refresh",
          clientId: "phx-client-id",
        },
      },
    })

    function darwin() {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
      return () => Object.defineProperty(process, "platform", original)
    }

    function keychain(output: string) {
      const exec = vi.fn((_file: string, _args: string[]) => output)
      return { exec, calls: () => exec.mock.calls }
    }

    test("a Keychain read extracts claudeAiOauth only, leaving no trace of the mcpOAuth sibling", async () => {
      const restore = darwin()
      const { exec } = keychain(KEYCHAIN_BLOB)
      try {
        const discovered = await collectLocalCredentialItems({ allowKeychainPrompt: true, exec })

        const claude = discovered.filter((item) => item.provider_id.startsWith("claude-"))
        expect(claude.map((item) => item.provider_id).sort()).toEqual(["claude-acp", "claude-sdk"])
        expect(JSON.parse(claude[0]!.secret)).toEqual({
          type: "claude_code_oauth",
          claudeAiOauth: { accessToken: "sk-ant-oat01-keychain" },
        })
        // Not just the Claude rows: nothing the scan produces may carry the
        // blob's other tenants, its refresh token, or the raw document.
        const produced = JSON.stringify(discovered)
        for (const leak of [
          "mcpOAuth",
          "phx-third-party-access",
          "phx-third-party-refresh",
          "phx-client-id",
          "refresh-keychain",
        ]) {
          expect(produced).not.toContain(leak)
        }
      } finally {
        restore()
      }
    })

    test("a Keychain blob with no claudeAiOauth accessToken yields no credential at all", async () => {
      const restore = darwin()
      const { exec } = keychain(JSON.stringify({
        mcpOAuth: {
          "posthog-mcp": { accessToken: "phx-third-party-access", clientId: "phx-client-id" },
        },
      }))
      try {
        const discovered = await collectLocalCredentialItems({ allowKeychainPrompt: true, exec })

        expect(discovered.filter((item) => item.provider_id.startsWith("claude-"))).toEqual([])
        const produced = JSON.stringify(discovered)
        expect(produced).not.toContain("mcpOAuth")
        expect(produced).not.toContain("phx-third-party-access")
        expect(produced).not.toContain("phx-client-id")
      } finally {
        restore()
      }
    })

    test("a plain (non-JSON) env token is still a token", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-plain-env"

      const discovered = await collectLocalCredentialItems()
      const claude = discovered.find((item) => item.provider_id === "claude-acp")

      expect(JSON.parse(claude!.secret)).toEqual({
        type: "claude_code_oauth",
        claudeAiOauth: { accessToken: "sk-ant-oat01-plain-env" },
      })
    })

    test("without allowKeychainPrompt nothing is spawned, and the credentials file answers instead", async () => {
      const restore = darwin()
      const { exec } = keychain(KEYCHAIN_BLOB)
      const dir = path.join(process.env.HOME!, ".claude")
      mkdirSync(dir, { recursive: true })
      await fs.writeFile(path.join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oauth-file" },
      }))
      try {
        const discovered = await collectLocalCredentialItems({ exec })

        expect(exec).not.toHaveBeenCalled()
        expect(JSON.parse(discovered.find((item) => item.provider_id === "claude-acp")!.secret)).toEqual({
          type: "claude_code_oauth",
          claudeAiOauth: { accessToken: "sk-ant-oauth-file" },
        })
      } finally {
        restore()
      }
    })

    test("syncLocalCredentials defaults to not prompting", async () => {
      const restore = darwin()
      const { exec } = keychain(KEYCHAIN_BLOB)
      try {
        await syncLocalCredentials(["claude-acp"], undefined, { exec })

        expect(exec).not.toHaveBeenCalled()
      } finally {
        restore()
      }
    })

    /**
     * Claude Code owns this item's lifecycle — it rotates the access token in
     * place and issues a single-use refresh token. A write from Claxedo would
     * either be clobbered or would strand the user's own Claude Code holding a
     * credential Anthropic has already invalidated. `find-generic-password` is
     * therefore the only subcommand this module may ever reach for.
     */
    test("only ever reads: no security subcommand other than find-generic-password", async () => {
      const restore = darwin()
      const { exec, calls } = keychain(KEYCHAIN_BLOB)
      try {
        await collectLocalCredentialItems({ allowKeychainPrompt: true, exec })
        await syncLocalCredentials(["claude-acp"], undefined, { allowKeychainPrompt: true, exec })

        expect(calls().length).toBeGreaterThan(0)
        for (const [file, args] of calls()) {
          expect(file).toBe("security")
          expect(args[0]).toBe("find-generic-password")
          expect(args).not.toContain("add-generic-password")
          expect(args).not.toContain("delete-generic-password")
          expect(args).not.toContain("-w-")
        }
      } finally {
        restore()
      }
    })
  })
})
