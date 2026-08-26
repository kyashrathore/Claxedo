import { describe, expect, test } from "bun:test"
import {
  CHAIN_SEPARATOR,
  formatError,
  formatInitError,
  isInitError,
  safeJson,
  type InitError,
  type Translator,
} from "./error-format"

// Deterministic translator: renders "<key>(<sorted vars>)" so assertions can
// check both the chosen message key and the interpolated values.
const t: Translator = (key, vars) => {
  if (!vars) return key
  const rendered = Object.keys(vars)
    .sort()
    .map((name) => `${name}=${vars[name]}`)
    .join(",")
  return `${key}(${rendered})`
}

const init = (name: string, data: Record<string, unknown>): InitError => ({ name, data })

describe("formatInitError variants", () => {
  test("MCPFailed uses the server name", () => {
    expect(formatInitError(init("MCPFailed", { name: "github" }), t)).toBe("error.chain.mcpFailed(name=github)")
  })

  test("MCPFailed falls back to empty name", () => {
    expect(formatInitError(init("MCPFailed", {}), t)).toBe("error.chain.mcpFailed(name=)")
  })

  test("ProviderAuthError carries provider + message", () => {
    expect(formatInitError(init("ProviderAuthError", { providerID: "anthropic", message: "401" }), t)).toBe(
      "error.chain.providerAuthFailed(message=401,provider=anthropic)",
    )
  })

  test("ProviderAuthError defaults provider to unknown", () => {
    expect(formatInitError(init("ProviderAuthError", {}), t)).toContain("provider=unknown")
  })

  test("APIError stacks status/retryable/body lines", () => {
    const out = formatInitError(
      init("APIError", { message: "boom", statusCode: 500, isRetryable: true, responseBody: "body" }),
      t,
    )
    expect(out.split("\n")).toEqual([
      "boom",
      "error.chain.status(status=500)",
      "error.chain.retryable(retryable=true)",
      "error.chain.responseBody(body=body)",
    ])
  })

  test("APIError omits absent optional lines and uses fallback message", () => {
    expect(formatInitError(init("APIError", {}), t)).toBe("error.chain.apiError")
  })

  test("ProviderModelNotFoundError includes suggestions when present", () => {
    const out = formatInitError(
      init("ProviderModelNotFoundError", { providerID: "p", modelID: "m", suggestions: ["a", "b"] }),
      t,
    )
    expect(out.split("\n")).toEqual([
      "error.chain.modelNotFound(model=m,provider=p)",
      "error.chain.didYouMean(suggestions=a, b)",
      "error.chain.checkConfig",
    ])
  })

  test("ProviderModelNotFoundError drops the suggestions line when empty", () => {
    const out = formatInitError(init("ProviderModelNotFoundError", { providerID: "p", modelID: "m" }), t)
    expect(out.split("\n")).toEqual(["error.chain.modelNotFound(model=m,provider=p)", "error.chain.checkConfig"])
  })

  test("ProviderInitError names the provider", () => {
    expect(formatInitError(init("ProviderInitError", { providerID: "x" }), t)).toBe(
      "error.chain.providerInitFailed(provider=x)",
    )
  })

  test("ConfigJsonError chooses the with-message key only when a message exists", () => {
    expect(formatInitError(init("ConfigJsonError", { path: "/c.json", message: "bad" }), t)).toBe(
      "error.chain.configJsonInvalidWithMessage(message=bad,path=/c.json)",
    )
    expect(formatInitError(init("ConfigJsonError", { path: "/c.json" }), t)).toBe(
      "error.chain.configJsonInvalid(path=/c.json)",
    )
  })

  test("ConfigDirectoryTypoError passes dir/path/suggestion", () => {
    expect(formatInitError(init("ConfigDirectoryTypoError", { path: "/p", dir: "/d", suggestion: "/s" }), t)).toBe(
      "error.chain.configDirectoryTypo(dir=/d,path=/p,suggestion=/s)",
    )
  })

  test("ConfigFrontmatterError passes path/message", () => {
    expect(formatInitError(init("ConfigFrontmatterError", { path: "/p", message: "m" }), t)).toBe(
      "error.chain.configFrontmatterError(message=m,path=/p)",
    )
  })

  test("ConfigInvalidError appends indented issue lines", () => {
    const out = formatInitError(
      init("ConfigInvalidError", {
        path: "/p",
        message: "top",
        issues: [{ message: "bad value", path: ["a", "b"] }, { message: "no path" }],
      }),
      t,
    )
    expect(out.split("\n")).toEqual(["error.chain.configInvalidWithMessage(message=top,path=/p)", "↳ bad value a.b"])
  })

  test("ConfigInvalidError without a message uses the plain key", () => {
    expect(formatInitError(init("ConfigInvalidError", { path: "/p" }), t)).toBe("error.chain.configInvalid(path=/p)")
  })

  test("UnknownError prefers the message, else JSON", () => {
    expect(formatInitError(init("UnknownError", { message: "m" }), t)).toBe("m")
    expect(formatInitError(init("UnknownError", { code: 1 }), t)).toBe(safeJson({ code: 1 }))
  })

  test("an unrecognized name falls through to message/JSON", () => {
    expect(formatInitError(init("SomethingElse", { message: "hi" }), t)).toBe("hi")
    expect(formatInitError(init("SomethingElse", { n: 2 }), t)).toBe(safeJson({ n: 2 }))
  })
})

describe("formatError chain + edge cases", () => {
  test("empty/nullish error resolves to the unknown key", () => {
    expect(formatError(undefined, t)).toBe("error.chain.unknown")
    expect(formatError(null, t)).toBe("error.chain.unknown")
  })

  test("an init error renders name + formatted message at depth 0 (no indent)", () => {
    const out = formatError(init("ProviderInitError", { providerID: "x" }), t)
    expect(out).toBe("ProviderInitError\nerror.chain.providerInitFailed(provider=x)")
  })

  test("a distinct cause is appended below a chain separator", () => {
    const parent = new Error("parent")
    parent.stack = "Error: parent\n  at parent"
    const cause = new Error("child")
    cause.stack = "Error: child\n  at child"
    parent.cause = cause

    const out = formatError(parent, t)
    expect(out).toContain(CHAIN_SEPARATOR)
    expect(out).toContain("error.chain.causedBy")
    expect(out).toContain("Error: child")
  })

  test("a cause whose message duplicates the parent is de-duplicated to its trace only", () => {
    const parent = new Error("same")
    parent.stack = "Error: same\n  at parentFrame"
    const cause = new Error("same")
    cause.stack = "Error: same\n  at causeFrame"
    parent.cause = cause

    const out = formatError(parent, t)
    // duplicate cause keeps its stack trace lines but not a repeated header
    expect(out).toContain("at causeFrame")
    expect(out.match(/Error: same/g)?.length).toBe(1)
  })

  test("an init-error cause whose formatted message duplicates the parent is dropped entirely", () => {
    // The parent Error's message equals the formatted rendering of the init-error
    // cause, so the isInitError dedup branch (depth > 0 && parentMessage === message)
    // returns "" and the caused-by block is omitted rather than repeated.
    const causeMessage = formatInitError(init("ProviderInitError", { providerID: "x" }), t)
    const parent = new Error(causeMessage)
    parent.stack = `Error: ${causeMessage}\n  at parentFrame`
    parent.cause = init("ProviderInitError", { providerID: "x" })

    const out = formatError(parent, t)
    expect(out).not.toContain(CHAIN_SEPARATOR)
    expect(out).not.toContain("error.chain.causedBy")
    // the rendered init message appears exactly once (in the parent), never re-emitted
    expect(out.match(/providerInitFailed\(provider=x\)/g)?.length).toBe(1)
  })

  test("an 'Unknown error' wrapper unwraps to its cause without adding a level", () => {
    const wrapper = new Error("Unknown error")
    wrapper.cause = new Error("real")
    // wrapper is unwrapped at the same depth, so no separator is introduced
    expect(formatError(wrapper, t)).not.toContain(CHAIN_SEPARATOR)
    expect(formatError(wrapper, t)).toContain("real")
  })

  test("a plain string error is returned as-is at depth 0", () => {
    expect(formatError("just a string", t)).toBe("just a string")
  })

  test("a non-error object is JSON-serialized", () => {
    expect(formatError({ a: 1 }, t)).toBe(safeJson({ a: 1 }))
  })
})

describe("safeJson", () => {
  test("serializes plain objects", () => {
    expect(safeJson({ a: 1, b: "x" })).toContain('"a": 1')
  })

  test("breaks circular references with [Circular]", () => {
    const cyclic: Record<string, unknown> = { name: "root" }
    cyclic.self = cyclic
    expect(safeJson(cyclic)).toContain("[Circular]")
  })

  test("stringifies bigint values", () => {
    expect(safeJson({ big: 10n })).toContain('"big": "10"')
  })
})

describe("isInitError", () => {
  test("accepts objects with name + object data", () => {
    expect(isInitError({ name: "X", data: {} })).toBe(true)
  })

  test("rejects errors, strings, and shape mismatches", () => {
    expect(isInitError(new Error("x"))).toBe(false)
    expect(isInitError("x")).toBe(false)
    expect(isInitError({ name: "X" })).toBe(false)
    expect(isInitError(null)).toBe(false)
  })
})
