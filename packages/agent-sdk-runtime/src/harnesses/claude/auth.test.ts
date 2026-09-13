import { describe, expect, test } from "bun:test"
import { claudeAuthEnv } from "./auth"
import { harnessProjection } from "../../harness-projection"
import type { ProviderProjection } from "../../provider-projection"

const key: ProviderProjection = {
  baseUrl: "http://127.0.0.1:2595/bindings/b1",
  placeholder: "placeholder-key",
  authMode: "api-key",
  expiresAt: 1_800_000_000_000,
}
const bearer: ProviderProjection = { ...key, placeholder: "placeholder-token", authMode: "bearer" }

describe("claudeAuthEnv", () => {
  test("an api-key projection sends the placeholder in the API-key variable", () => {
    expect(claudeAuthEnv(key)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2595/bindings/b1",
      ANTHROPIC_API_KEY: "placeholder-key",
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    })
  })

  test("a bearer projection sends the placeholder in the auth-token variable", () => {
    expect(claudeAuthEnv(bearer)).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2595/bindings/b1",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: "placeholder-token",
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    })
  })

  /**
   * This row is spread over `process.env`. Without the explicit `undefined`s an
   * operator's own key would survive the spread and be the value the CLI sends
   * to the broker's base URL — the one outcome this path exists to stop.
   */
  test("credential variables inherited from the parent process are cleared", () => {
    const parent = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "operator-own-key",
      CLAUDE_CODE_OAUTH_TOKEN: "operator-own-token",
    }
    const spawned: Record<string, string | undefined> = { ...parent, ...claudeAuthEnv(bearer) }
    expect(spawned.ANTHROPIC_API_KEY).toBeUndefined()
    expect(spawned.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(spawned.ANTHROPIC_AUTH_TOKEN).toBe("placeholder-token")
  })

  test("no projection sets no variables, so the CLI uses its own login", () => {
    expect(claudeAuthEnv(undefined)).toEqual({})
  })
})

describe("harnessProjection", () => {
  test("prefers the native SDK binding over a bare vendor provider id", () => {
    expect(harnessProjection({ "claude-sdk": key, anthropic: bearer }, "claude")).toBe(key)
  })

  test("a stored vendor account binds the harness that answers to it", () => {
    // `anthropic` and `cursor` are ordinary stored rows, and a reader that
    // stopped at the harness's own aliases would leave the turn on the
    // machine's login with an account selected.
    expect(harnessProjection({ anthropic: bearer }, "claude")).toBe(bearer)
    expect(harnessProjection({ cursor: bearer }, "cursor")).toBe(bearer)
    expect(harnessProjection({ openai: bearer }, "codex")).toBe(bearer)
  })

  test("another harness's binding decides nothing", () => {
    expect(harnessProjection({ "claude-sdk": key }, "cursor")).toBeUndefined()
    expect(harnessProjection({ "cursor-sdk": key }, "claude")).toBeUndefined()
    expect(harnessProjection({}, "claude")).toBeUndefined()
    expect(harnessProjection(undefined, "claude")).toBeUndefined()
  })
})
