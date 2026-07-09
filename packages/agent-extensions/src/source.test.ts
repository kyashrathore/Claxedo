import { describe, expect, test } from "bun:test"
import { parsePackageSource, safeRelativePath } from "./source"

describe("Agent Extension source parsing", () => {
  test("accepts GitHub shorthand sources", () => {
    expect(parsePackageSource("owner/repo")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
    })
    expect(parsePackageSource("owner/repo@v1.2.3")).toEqual({
      type: "github",
      owner: "owner",
      repo: "repo",
      ref: "v1.2.3",
    })
  })

  test("accepts GitHub URL and .git URL forms", () => {
    expect(parsePackageSource("https://github.com/acme/tools")).toEqual({
      type: "github",
      owner: "acme",
      repo: "tools",
    })
    expect(parsePackageSource("https://github.com/acme/tools.git")).toEqual({
      type: "github",
      owner: "acme",
      repo: "tools",
    })
  })

  test("accepts GitHub tree package roots", () => {
    expect(parsePackageSource("https://github.com/acme/tools/tree/main/packages/review")).toEqual({
      type: "github",
      owner: "acme",
      repo: "tools",
      ref: "main",
      package_path: "packages/review",
    })
  })

  test("rejects unsupported and unsafe sources", () => {
    expect(() => parsePackageSource("http://github.com/acme/tools")).toThrow("Only https://github.com sources are supported")
    expect(() => parsePackageSource("https://example.com/acme/tools")).toThrow("Only https://github.com sources are supported")
    expect(() => parsePackageSource("https://github.com/acme/tools/blob/main/plugin.json")).toThrow("Only GitHub repo roots")
    expect(() => parsePackageSource("https://github.com/acme/tools/tree/main/../escape")).toThrow("package path must stay inside")
    expect(() => parsePackageSource("acme/tools@../main")).toThrow("GitHub ref is unsafe")
    expect(() => parsePackageSource("acme/tools@--upload-pack=/tmp/evil")).toThrow("GitHub ref is unsafe")
  })

  test("normalizes and rejects unsafe relative paths", () => {
    expect(safeRelativePath("packages/review/")).toBe("packages/review")
    expect(() => safeRelativePath("/packages/review")).toThrow("must be relative")
    expect(() => safeRelativePath("../review")).toThrow("must stay inside")
    expect(() => safeRelativePath("review\\plugin")).toThrow("must not contain backslashes")
    expect(() => safeRelativePath("")).toThrow("must be a non-empty relative path")
  })
})
