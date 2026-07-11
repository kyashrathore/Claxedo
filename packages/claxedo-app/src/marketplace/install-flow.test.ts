import { describe, expect, it } from "bun:test"
import {
  catalogEntryFromJson,
  catalogFromJson,
  categoryEntries,
  discoveredExtensionFromJson,
  discoveredExtensionsFromJson,
  installedRecordsFromJson,
  isEntryInstalled,
  jsonOrError,
  machineItemFromJson,
  machineItemsFromJson,
  packageNameFromSource,
  responseErrorMessage,
  type CatalogEntry,
} from "./install-flow"

function fullEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "acme",
    name: "Acme",
    description: "An extension",
    source: "github.com/acme/acme",
    kind: "skill",
    categories: ["skills"],
    recommendedScope: "project",
    recommendedTargets: ["claude"],
    ...overrides,
  }
}

describe("catalogEntryFromJson", () => {
  it("parses a well-formed entry", () => {
    expect(catalogEntryFromJson(fullEntry())).toEqual([fullEntry()])
  })

  it("drops an entry missing a required field", () => {
    const { source: _source, ...withoutSource } = fullEntry()
    expect(catalogEntryFromJson(withoutSource)).toEqual([])
  })

  it("drops an entry with an invalid kind", () => {
    expect(catalogEntryFromJson({ ...fullEntry(), kind: "wormhole" })).toEqual([])
  })

  it("drops an entry with an invalid recommendedScope", () => {
    expect(catalogEntryFromJson({ ...fullEntry(), recommendedScope: "galaxy" })).toEqual([])
  })

  it("filters out unknown categories and targets rather than failing", () => {
    const parsed = catalogEntryFromJson({
      ...fullEntry(),
      categories: ["skills", "not-a-category"],
      recommendedTargets: ["claude", "not-a-target"],
    })
    expect(parsed[0].categories).toEqual(["skills"])
    expect(parsed[0].recommendedTargets).toEqual(["claude"])
  })

  it("carries optional icon / featured / firstParty only when valid", () => {
    const parsed = catalogEntryFromJson({ ...fullEntry(), icon: "x", featured: true, firstParty: "claxedo" })
    expect(parsed[0]).toMatchObject({ icon: "x", featured: true, firstParty: "claxedo" })
    const noOpt = catalogEntryFromJson({ ...fullEntry(), featured: "yes", firstParty: "other" })
    expect(noOpt[0].featured).toBeUndefined()
    expect(noOpt[0].firstParty).toBeUndefined()
  })

  it("returns [] for non-object input", () => {
    expect(catalogEntryFromJson(null)).toEqual([])
    expect(catalogEntryFromJson("nope")).toEqual([])
  })
})

describe("catalogFromJson", () => {
  it("parses a catalog and drops malformed entries/categories", () => {
    const catalog = catalogFromJson({
      version: 1,
      categories: [{ id: "skills", label: "Skills" }, { id: "bogus", label: "Bogus" }, { nope: true }],
      entries: [fullEntry(), { junk: true }],
    })
    expect(catalog.categories).toEqual([{ id: "skills", label: "Skills" }])
    expect(catalog.entries).toEqual([fullEntry()])
  })

  it("throws on a wrong version or missing fields", () => {
    expect(() => catalogFromJson({ version: 2, categories: [], entries: [] })).toThrow("Invalid catalog response")
    expect(() => catalogFromJson({ version: 1, entries: [] })).toThrow("Invalid catalog response")
    expect(() => catalogFromJson(null)).toThrow("Invalid catalog response")
  })
})

describe("installedRecordsFromJson", () => {
  it("maps desired.installs into scoped records", () => {
    const records = installedRecordsFromJson(
      { desired: { installs: [{ id: "a", package_name: "acme" }, { id: "b" }] } },
      "project",
      "/repo",
    )
    expect(records).toEqual([
      { id: "a", package_name: "acme", scope: "project", directory: "/repo" },
      { id: "b", scope: "project", directory: "/repo" },
    ])
  })

  it("skips installs without a string id", () => {
    const records = installedRecordsFromJson({ desired: { installs: [{ id: 1 }, "nope", { id: "ok" }] } }, "machine", undefined)
    expect(records).toEqual([{ id: "ok", scope: "machine", directory: undefined }])
  })

  it("returns undefined for a shape without desired.installs", () => {
    expect(installedRecordsFromJson({ desired: {} }, "machine", undefined)).toBeUndefined()
    expect(installedRecordsFromJson(null, "machine", undefined)).toBeUndefined()
  })
})

describe("discoveredExtensionFromJson", () => {
  it("maps the legacy runner-config-dir kind to harness-config-dir", () => {
    expect(discoveredExtensionFromJson({ path: "/p", kind: "runner-config-dir", state: "discovered" })).toEqual([
      { path: "/p", kind: "harness-config-dir", state: "discovered" },
    ])
  })

  it("drops entries with an unknown kind or state", () => {
    expect(discoveredExtensionFromJson({ path: "/p", kind: "nope", state: "discovered" })).toEqual([])
    expect(discoveredExtensionFromJson({ path: "/p", kind: "skills-dir", state: "exploded" })).toEqual([])
  })

  it("discoveredExtensionsFromJson throws on non-array input", () => {
    expect(() => discoveredExtensionsFromJson({})).toThrow("Invalid scan response")
    expect(discoveredExtensionsFromJson([{ path: "/p", kind: "skills-dir", state: "adopted" }])).toHaveLength(1)
  })
})

describe("machineItemFromJson", () => {
  it("accepts either a harness or a legacy runner field", () => {
    const base = { id: "x", name: "X", kind: "skill", path: "/p" }
    expect(machineItemFromJson({ ...base, harness: "claude" })[0].harness).toBe("claude")
    expect(machineItemFromJson({ ...base, runner: "codex" })[0].harness).toBe("codex")
  })

  it("drops items with an unknown harness or kind", () => {
    expect(machineItemFromJson({ id: "x", name: "X", kind: "skill", path: "/p", harness: "nope" })).toEqual([])
    expect(machineItemFromJson({ id: "x", name: "X", kind: "nope", path: "/p", harness: "claude" })).toEqual([])
  })

  it("machineItemsFromJson returns undefined for non-array input", () => {
    expect(machineItemsFromJson({})).toBeUndefined()
    expect(machineItemsFromJson([{ id: "x", name: "X", kind: "mcp", path: "/p", harness: "agents" }])).toHaveLength(1)
  })
})

describe("packageNameFromSource", () => {
  it("takes the last path segment, lowercased, trailing slashes trimmed", () => {
    expect(packageNameFromSource("github.com/Acme/My-Tool/")).toBe("my-tool")
    expect(packageNameFromSource("Acme")).toBe("acme")
  })
})

describe("isEntryInstalled", () => {
  it("matches by id or by resolved package name", () => {
    const entry = fullEntry({ id: "acme", source: "github.com/acme/My-Tool" })
    expect(isEntryInstalled(entry, new Set(["acme"]))).toBe(true)
    expect(isEntryInstalled(entry, new Set(["my-tool"]))).toBe(true)
    expect(isEntryInstalled(entry, new Set(["unrelated"]))).toBe(false)
  })
})

describe("categoryEntries", () => {
  it("returns all entries for 'all', filters by category otherwise", () => {
    const entries = [fullEntry({ id: "a", categories: ["skills"] }), fullEntry({ id: "b", categories: ["productivity"] })]
    expect(categoryEntries(entries, "all")).toHaveLength(2)
    expect(categoryEntries(entries, "skills").map((entry) => entry.id)).toEqual(["a"])
  })
})

describe("response helpers", () => {
  it("responseErrorMessage reads string and nested-object error shapes", () => {
    expect(responseErrorMessage({ error: "boom" })).toBe("boom")
    expect(responseErrorMessage({ error: { message: "nested" } })).toBe("nested")
    expect(responseErrorMessage({ ok: true })).toBeUndefined()
  })

  it("jsonOrError resolves the body on ok and throws the server error on failure", async () => {
    const okBody = await jsonOrError(new Response(JSON.stringify({ value: 1 }), { status: 200 }))
    expect(okBody).toEqual({ value: 1 })
    await expect(jsonOrError(new Response(JSON.stringify({ error: "denied" }), { status: 403 }))).rejects.toThrow("denied")
    await expect(jsonOrError(new Response("nope", { status: 500 }))).rejects.toThrow("Request failed: 500")
  })
})
