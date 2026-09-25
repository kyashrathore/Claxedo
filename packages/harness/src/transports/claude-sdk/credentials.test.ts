import { describe, expect, test } from "bun:test"
import type { ResolvedCredentials } from "../../contract"
import { claudeBinding, claudeEnvironment } from "./credentials"

const machine = { kind: "machine-owner" } as const
const person = { kind: "person", userId: "owner" } as const
const empty: ResolvedCredentials = { providers: {}, secrets: {}, leaseGeneration: "g1" }

describe("Claude session credentials", () => {
  test("a machine owner without a projection keeps their own login", () => {
    expect(claudeBinding(empty, machine)).toBeUndefined()
    expect(claudeEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: "own", PATH: "/bin" })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "own", PATH: "/bin" })
  })

  test("a person without a selected projection cannot fall through to a machine login", () => {
    expect(() => claudeBinding(empty, person)).toThrow("no selected credentials")
  })

  test.each(["api-key", "bearer"])("a %s binding replaces inherited provider credentials before spawn", (authMode) => {
    const binding = { baseUrl: "http://127.0.0.1:47800", placeholder: "placeholder", authMode }
    const selected = claudeBinding({ ...empty, providers: { anthropic: binding } }, person)
    const env = claudeEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "operator-own", ANTHROPIC_AUTH_TOKEN: "operator-own",
      CLAUDE_CODE_OAUTH_TOKEN: "operator-own", CLAUDE_CODE_OAUTH_SCOPES: "operator-own",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "local-secret", CLAXEDO_OTHER_SECRET: "other-secret" }, selected, "/claxedo/claude")
    expect(env.ANTHROPIC_BASE_URL).toBe(binding.baseUrl)
    expect(env[authMode === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]).toBe("placeholder")
    expect(env[authMode === "api-key" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"]).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBeUndefined()
    expect(env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN).toBe("local-secret")
    expect(env.CLAXEDO_OTHER_SECRET).toBe("other-secret")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/claxedo/claude")
  })

  test("native binding takes precedence over the vendor binding", () => {
    const chosen = claudeBinding({ ...empty, providers: {
      "claude-sdk": { baseUrl: "http://127.0.0.1:47801", placeholder: "native", authMode: "api-key" },
      anthropic: { baseUrl: "http://127.0.0.1:47802", placeholder: "vendor", authMode: "api-key" },
    } }, person)
    expect(chosen?.placeholder).toBe("native")
  })

  test("an ACP Claude binding is eligible for the native SDK transport", () => {
    const chosen = claudeBinding({ ...empty, providers: {
      "claude-acp": { baseUrl: "http://127.0.0.1:47803", placeholder: "acp-binding", authMode: "api-key" },
    } }, person)
    expect(chosen?.placeholder).toBe("acp-binding")
  })

  test("an unavailable or expired selection refuses launch", () => {
    expect(() => claudeBinding({ ...empty, providers: { anthropic: { unavailable: true, reason: "withdrawn" } } }, person)).toThrow("withdrawn")
    expect(() => claudeBinding({ ...empty, providers: { anthropic: {
      baseUrl: "http://127.0.0.1:47800", placeholder: "expired", authMode: "api-key", expiresAt: 10,
    } } }, person, 11)).toThrow("expired")
  })
})
