import { describe, expect, test } from "bun:test"
import { claudeAuthEnv, claudeAuthValue } from "./auth"

describe("claudeAuthEnv", () => {
  /**
   * The onboarding cloud path for a Claude subscription is: the user runs
   * `claude setup-token`, pastes the `sk-ant-oat01-…` it prints, and the app
   * stores it through the API-key save path as `kind: "api_key"`.
   *
   * Nothing in that path tells this function what it is holding — the value
   * arrives as a bare string. It is the `sk-ant-o` prefix ALONE that routes a
   * setup-token to CLAUDE_CODE_OAUTH_TOKEN instead of ANTHROPIC_API_KEY, and
   * Claude Code rejects a subscription token presented as an API key. So the
   * whole feature rests on this one branch.
   */
  test("a pasted setup-token is presented as an OAuth token, not an API key", () => {
    expect(claudeAuthEnv("sk-ant-oat01-abc123")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc123" })
  })

  test("a real API key stays an API key", () => {
    expect(claudeAuthEnv("sk-ant-api03-abc123")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-abc123" })
  })

  test("surrounding whitespace from a paste does not change which variable is used", () => {
    // A token pasted out of a terminal usually arrives with a trailing newline.
    expect(claudeAuthEnv("  sk-ant-oat01-abc123\n")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc123" })
  })

  test("a discovered Keychain login is read from claudeAiOauth and nothing else", () => {
    const secret = JSON.stringify({
      type: "claude_code_oauth",
      claudeAiOauth: { accessToken: "keychain-access" },
      // The Keychain item also holds unrelated third-party MCP tokens. They
      // must never reach a harness environment.
      mcpOAuth: { "posthog-mcp": { accessToken: "unrelated-third-party" } },
    })

    const env = claudeAuthEnv(secret)
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "keychain-access" })
    expect(JSON.stringify(env)).not.toContain("unrelated-third-party")
  })

  test("an explicit env-var shape wins over prefix sniffing", () => {
    expect(claudeAuthEnv(JSON.stringify({ ANTHROPIC_API_KEY: "explicit-key" })))
      .toEqual({ ANTHROPIC_API_KEY: "explicit-key" })
    expect(claudeAuthEnv(JSON.stringify({ ANTHROPIC_AUTH_TOKEN: "explicit-token" })))
      .toEqual({ ANTHROPIC_AUTH_TOKEN: "explicit-token" })
    expect(claudeAuthEnv(JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "explicit-oauth" })))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "explicit-oauth" })
  })

  test("no credential sets no variables, so the CLI uses its own login", () => {
    // The local case: an empty env means the spawned binary reads the machine's
    // own Claude Code login exactly as it would in a terminal.
    expect(claudeAuthEnv(undefined)).toEqual({})
    expect(claudeAuthEnv("")).toEqual({})
    expect(claudeAuthEnv("   ")).toEqual({})
  })
})

describe("claudeAuthValue", () => {
  test("prefers the agent SDK binding, then the ACP one, over a bare provider id", () => {
    expect(claudeAuthValue({ "claude-sdk": "sdk", "claude-acp": "acp", anthropic: "bare" })).toBe("sdk")
    expect(claudeAuthValue({ "claude-acp": "acp", anthropic: "bare" })).toBe("acp")
    expect(claudeAuthValue({ anthropic: "bare" })).toBe("bare")
  })

  test("both harness bindings of one login resolve, so neither harness is stranded", () => {
    // Onboarding writes both `claude-acp` and `claude-sdk` from one row; each
    // harness resolves auth by its own provider id.
    expect(claudeAuthValue({ "claude-acp": "token" })).toBe("token")
    expect(claudeAuthValue({ "claude-sdk": "token" })).toBe("token")
    expect(claudeAuthValue({})).toBeUndefined()
  })
})
