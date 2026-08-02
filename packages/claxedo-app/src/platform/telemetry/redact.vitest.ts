import { describe, expect, test } from "vitest"
import { fnv1aHex, redactedPath, redactedPathValues } from "./redact"

const paths = [
  "/Users/ada/work/secret-client/src/features/billing/invoice.tsx",
  "/repo/README.md",
  "C:/Users/ada/notes.txt",
  "/repo/no-extension",
  "relative/path/to/file.TS",
]

describe("path redaction", () => {
  test("emits only an extension and a hash", () => {
    for (const path of paths) {
      expect(Object.keys(redactedPath(path)).sort()).toEqual(["extension", "path_hash"])
    }
  })

  test("carries no path fragment, directory name, or basename", () => {
    for (const path of paths) {
      const values = Object.values(redactedPath(path))
      expect(values.some((value) => value.includes("/"))).toBe(false)
      const segments = path.split("/").filter(Boolean)
      for (const segment of segments) {
        const base = segment.includes(".") ? segment.slice(0, segment.lastIndexOf(".")) : segment
        expect(values.some((value) => value.includes(base))).toBe(false)
      }
    }
  })

  test("lower-cases the extension and leaves it empty when there is none", () => {
    expect(redactedPath("relative/path/to/file.TS").extension).toBe("ts")
    expect(redactedPath("/repo/no-extension").extension).toBe("")
    expect(redactedPath("/repo/.gitignore").extension).toBe("")
  })

  test("hashes the whole path, so sibling files stay distinguishable", () => {
    const a = redactedPath("/repo/src/a.ts")
    const b = redactedPath("/repo/src/b.ts")
    expect(a.path_hash).not.toBe(b.path_hash)
    expect(redactedPath("/repo/src/a.ts").path_hash).toBe(a.path_hash)
  })
})

describe("flow property redaction", () => {
  test("hashes path-shaped values and leaves the rest alone", () => {
    const redacted = redactedPathValues({
      workspaceDir: "/Users/ada/work/secret-client",
      routeDir: "C:\\Users\\ada\\work",
      tabDir: null,
      projectId: "prj_123",
      focusedPane: "pane-1",
      isCloud: true,
      count: 3,
    })

    expect(redacted.workspaceDir).toMatch(/^[0-9a-f]{8}$/)
    expect(redacted.routeDir).toMatch(/^[0-9a-f]{8}$/)
    expect(redacted).toMatchObject({
      tabDir: null,
      projectId: "prj_123",
      focusedPane: "pane-1",
      isCloud: true,
      count: 3,
    })
    expect(Object.values(redacted).some((value) => String(value).includes("/"))).toBe(false)
    expect(Object.values(redacted).some((value) => String(value).includes("ada"))).toBe(false)
  })

  test("keeps the property set identical", () => {
    const input = { workspaceDir: "/repo", routeDir: "/repo/sub", sessionId: "ses_1" }
    expect(Object.keys(redactedPathValues(input))).toEqual(Object.keys(input))
  })
})

describe("digest", () => {
  test("is stable, fixed width, and never echoes the input", () => {
    const id = "telegram:8675309"
    expect(fnv1aHex(id)).toBe(fnv1aHex(id))
    expect(fnv1aHex(id)).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1aHex(id)).not.toContain("8675309")
  })

  test("matches the published FNV-1a digest for the reference inputs", () => {
    expect(fnv1aHex("")).toBe("811c9dc5")
    expect(fnv1aHex("a")).toBe("e40c292c")
    expect(fnv1aHex("foobar")).toBe("bf9cf968")
  })
})
