import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { describe, expect, test, vi } from "vitest"
import { resolveCollections } from "@claxedo/server-core/agent-plugins/catalog/resolve-collections"
import { githubRepositoryCatalogSourceProvider, type AgentPluginSourceFetch } from "./github-public"

const sha = "a".repeat(40)

async function archive(files: Record<string, string>) {
  const output = new Uint8ArrayWriter()
  const writer = new ZipWriter(output)
  for (const [path, content] of Object.entries(files)) await writer.add(`plugins-${sha}/${path}`, new TextReader(content))
  return writer.close()
}

function provider(zip: Uint8Array, status = 200) {
  const fetcher = vi.fn<AgentPluginSourceFetch>(async (input, _init) => {
    const url = String(input)
    return url.startsWith("https://api.github.com/")
      ? new Response(JSON.stringify({ sha }), { status: 200 })
      : new Response(zip.slice().buffer, { status })
  })
  return { provider: githubRepositoryCatalogSourceProvider({
    id: "claxedo",
    kind: "claxedo",
    label: "Claxedo",
    owner: "kyashrathore",
    repository: "plugins",
    ref: "main",
    fetch: fetcher,
  }), fetcher }
}

describe("githubRepositoryCatalogSourceProvider", () => {
  test("resolves a ref to a commit and indexes only immediate plugin children", async () => {
    const zip = await archive({
      "review/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review" }),
      "nested/group/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "nested" }),
      "README.md": "ignored",
    })
    const { provider: source, fetcher } = provider(zip)
    const result = await resolveCollections(source)
    expect(result.collections[0]?.source.revision).toBe(sha)
    // The Directory shows the repository a candidate came from, so the source
    // carries it beside its id, kind, and label.
    expect((await source.listAuthorizedSources())[0]).toMatchObject({
      id: "claxedo",
      kind: "claxedo",
      label: "Claxedo",
      repository: "kyashrathore/plugins",
    })
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
    expect(refreshed[0]).toMatchObject({ repository: "kyashrathore/plugins" })
  })

  test("refuses a ref that could traverse out of the repository", async () => {
    const fetcher = vi.fn()
    const source = githubRepositoryCatalogSourceProvider({
      id: "github:acme/plugins@../etc",
      kind: "personal",
      label: "acme/plugins",
      owner: "acme",
      repository: "plugins",
      ref: "../etc",
      fetch: fetcher,
    })
    const [resolved] = await source.listAuthorizedSources()
    expect(resolved?.errors).toEqual([expect.objectContaining({ code: "source_unavailable" })])
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe("GitHub rate limits", () => {
  test("a rate-limited commit lookup falls back to the archive by ref name", async () => {
    const zip = await archive({ "review/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review" }) })
    const urls: string[] = []
    const fetcher = vi.fn<AgentPluginSourceFetch>(async (input) => {
      const url = String(input); urls.push(url)
      if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 })
      return new Response(zip.slice().buffer, { status: 200 })
    })
    const provider = githubRepositoryCatalogSourceProvider({ id: "claxedo", kind: "claxedo", label: "Claxedo", owner: "kyashrathore", repository: "plugins", ref: "main", fetch: fetcher })
    const [source] = await provider.listAuthorizedSources()
    expect(urls[1]).toBe("https://codeload.github.com/kyashrathore/plugins/zip/refs/heads/main")
    expect(source?.revision).toBe("main")
    expect(source?.plugins.map((plugin) => plugin.relativePath)).toEqual(["review"])
  })

  test("a configured token rides on the commit lookup only", async () => {
    const zip = await archive({ "review/plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review" }) })
    const headers: Array<string | undefined> = []
    const fetcher = vi.fn<AgentPluginSourceFetch>(async (input, init) => {
      const url = String(input); headers.push(new Headers(init?.headers).get("authorization") ?? undefined)
      return url.startsWith("https://api.github.com/") ? new Response(JSON.stringify({ sha }), { status: 200 }) : new Response(zip.slice().buffer, { status: 200 })
    })
    await githubRepositoryCatalogSourceProvider({ id: "c", kind: "claxedo", label: "C", owner: "o", repository: "r", ref: "main", fetch: fetcher, token: "ghp_test" }).listAuthorizedSources()
    expect(headers).toEqual(["Bearer ghp_test", undefined])
  })
})
