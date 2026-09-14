import { describe, expect, test } from "bun:test"
import { claudeAuthEnv } from "./auth"
import { harnessSpawnEnv } from "../shared/spawn-env"
import { harnessProjection } from "../../harness-projection"
import type { ProviderProjection } from "../../provider-projection"

const key: ProviderProjection = {
  baseUrl: "http://127.0.0.1:2595/bindings/b1",
  placeholder: "placeholder-key",
  authMode: "api-key",
  expiresAt: 1_800_000_000_000,
}
const bearer: ProviderProjection = { ...key, placeholder: "placeholder-token", authMode: "bearer" }

/** A parent process holding every credential the CLI knows how to read. */
const parent = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "operator-own-key",
  ANTHROPIC_AUTH_TOKEN: "operator-own-token",
  CLAUDE_CODE_OAUTH_TOKEN: "operator-own-oauth",
  CLAUDE_CODE_OAUTH_SCOPES: "user:inference user:profile",
}

describe("claudeAuthEnv", () => {
  test("an api-key projection sends the placeholder in the API-key variable", () => {
    expect(claudeAuthEnv(key)).toStrictEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2595/bindings/b1",
      ANTHROPIC_API_KEY: "placeholder-key",
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_SCOPES: undefined,
    })
  })

  test("a bearer projection sends the placeholder in the auth-token variable", () => {
    expect(claudeAuthEnv(bearer)).toStrictEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2595/bindings/b1",
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: "placeholder-token",
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_SCOPES: undefined,
    })
  })

  /**
   * The row is spread over the parent's environment and then filtered by
   * `harnessSpawnEnv`, which is what turns an `undefined` entry into an absent
   * variable. A key the row does not name survives the spread untouched, so
   * the whole set the CLI reads has to be named: the operator's own key would
   * otherwise be the value sent to the broker's base URL, and inherited OAuth
   * scopes would describe an account the placeholder does not name.
   */
  test.each([
    ["api-key", key, "ANTHROPIC_API_KEY"],
    ["bearer", bearer, "ANTHROPIC_AUTH_TOKEN"],
  ] as const)("a %s projection leaves the placeholder as the only credential a populated parent hands down", (_mode, projection, carrier) => {
    expect(harnessSpawnEnv({ ...parent, ...claudeAuthEnv(projection) })).toStrictEqual({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2595/bindings/b1",
      [carrier]: projection.placeholder,
    })
  })

  test("no projection sets no variables, so the CLI uses its own login", () => {
    expect(claudeAuthEnv(undefined)).toStrictEqual({})
    expect(harnessSpawnEnv({ ...parent, ...claudeAuthEnv(undefined) })).toStrictEqual(parent)
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
