import { afterEach, describe, expect, test } from "bun:test"
import {
  ANTHROPIC_BASE_URL_OPT_IN_ENV,
  ANTHROPIC_DEFAULT_BASE_URL,
  __anthropicCredentialPathForTest as subject,
} from "@/provider/provider"

/**
 * The two halves of the "Couldn't reach Anthropic — Not Found" failure, both
 * observed on a real boot: the engine's request arrived at the ambient
 * ANTHROPIC_BASE_URL host carrying `x-api-key: sk-ant-oat01-…`.
 */
describe("anthropic base URL", () => {
  test("ignores the ambient ANTHROPIC_BASE_URL a shell exports for other tools", () => {
    // The reported failure: a proxy the user runs for their CLI silently
    // captured the engine too, then rejected its credential.
    expect(subject.baseURL(undefined, { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }))
      .toBe(ANTHROPIC_DEFAULT_BASE_URL)
  })

  test("honours explicit provider config — configuring THIS provider means it", () => {
    expect(subject.baseURL("https://gateway.example/v1", { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }))
      .toBe("https://gateway.example/v1")
  })

  test("honours the engine-specific opt-in env", () => {
    expect(subject.baseURL(undefined, { [ANTHROPIC_BASE_URL_OPT_IN_ENV]: "http://127.0.0.1:9999" }))
      .toBe("http://127.0.0.1:9999")
  })

  test("config outranks the opt-in env", () => {
    expect(subject.baseURL("https://config.example/v1", { [ANTHROPIC_BASE_URL_OPT_IN_ENV]: "http://env.example" }))
      .toBe("https://config.example/v1")
  })

  test("falls back to the public API when nothing is configured", () => {
    expect(subject.baseURL(undefined, {})).toBe(ANTHROPIC_DEFAULT_BASE_URL)
    // An empty string is "unset", not a valid override.
    expect(subject.baseURL("", {})).toBe(ANTHROPIC_DEFAULT_BASE_URL)
    expect(subject.baseURL(undefined, { [ANTHROPIC_BASE_URL_OPT_IN_ENV]: "   " })).toBe(ANTHROPIC_DEFAULT_BASE_URL)
  })
})

describe("anthropic credential shape", () => {
  test("recognises OAuth setup-token material stored as an api key", () => {
    // `claude setup-token` output pasted through the API-key path; auth.json
    // records {type:"api"}, but the wire needs a bearer token.
    expect(subject.isOAuth("sk-ant-oat01-FSCabc123")).toBe(true)
  })

  test("matches on the trimmed value — pasted tokens carry a trailing newline", () => {
    expect(subject.isOAuth("sk-ant-oat01-FSCabc123\n")).toBe(true)
    expect(subject.isOAuth("  sk-ant-oat01-FSCabc123  ")).toBe(true)
  })

  test("leaves a real API key on the x-api-key path", () => {
    expect(subject.isOAuth("sk-ant-api03-realkey")).toBe(false)
  })

  test("ignores absent or non-string credentials", () => {
    expect(subject.isOAuth(undefined)).toBe(false)
    expect(subject.isOAuth("")).toBe(false)
    expect(subject.isOAuth(12345)).toBe(false)
  })
})
