import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { describe, expect, test, vi } from "vitest"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import { publicGitHubCatalogSourceProvider } from "./github-public"

const sha = "a".repeat(40)

async function archive(files: Record<string, string>) {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output)
  for (const [path, content] of Object.entries(files)) await writer.add(`plugins-${sha}/${path}`, new TextReader(content))
  return writer.close()
}

function provider(zip: Uint8Array, status = 200) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.startsWith("https://api.github.com/")
    ? new Response(JSON.stringify({ sha }), { status: 200 })
    : new Response(zip.slice().buffer, { status }))
  return { provider: publicGitHubCatalogSourceProvider({
    collections: [{ id: "claxedo", kind: "claxedo", label: "Claxedo", owner: "kyashrathore", repository: "plugins", ref: "main" }],
    fetch: fetcher as unknown as typeof fetch,
  }), fetcher }
}

describe("publicGitHubCatalogSourceProvider", () => {
  test("resolves a ref to a commit and indexes only immediate plugin children", async () => {
    const zip = await archive({
      "review/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review" }),
      "nested/group/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "nested" }),
      "README.md": "ignored",
    })
    const { provider: source, fetcher } = provider(zip)
    const result = await resolveCollections(source)
    expect(result.collections[0]?.source.revision).toBe(sha)
    expect(result.candidates.map((candidate) => candidate.manifest.name)).toEqual(["review"])
    expect(result.errors).toEqual([expect.objectContaining({ relativePath: "nested", code: "manifest_invalid" })])
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://codeload.github.com/kyashrathore/plugins/zip/${sha}`)
    expect(fetcher.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
  })

  test("caches normal reads, refreshes explicitly, and returns an ordinary source error", async () => {
    const { provider: source, fetcher } = provider(new Uint8Array(), 404)
    const first = await source.listAuthorizedSources()
    const second = await source.listAuthorizedSources()
    expect(second).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const refreshed = await source.listAuthorizedSources({ fresh: true })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(refreshed[0]?.errors).toEqual([expect.objectContaining({ code: "source_unavailable" })])
  })
})
