import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import type { AgentPluginSourceFetch } from "./github-public"

/**
 * A GitHub `fetch` that answers the two calls the repository source adapter
 * makes: the commit lookup and the codeload archive download.
 *
 * It lives beside the adapter, in the one package that depends on the zip
 * library, because both rails' source-route tests need the SAME bytes the real
 * provider parses. Mocking the adapter instead would leave the listing and
 * validation path -- the thing `POST /sources` decides on -- untested.
 */
export function gitHubArchiveFetch(input: {
  /** Repository-relative paths to file contents, e.g. `review/plugin.json`. */
  files: Record<string, string>
  /** The commit the ref resolves to; defaults to a stable fake. */
  sha?: string
  /** The repository name the archive root is written under. */
  repository?: string
}) {
  const sha = input.sha ?? "a".repeat(40)
  const root = `${input.repository ?? "plugins"}-${sha}`
  const archive = (async () => {
    const output = new Uint8ArrayWriter()
    const writer = new ZipWriter(output)
    for (const [path, content] of Object.entries(input.files)) {
      await writer.add(`${root}/${path}`, new TextReader(content))
    }
    return await writer.close()
  })()
  const calls: string[] = []
  const fetcher: AgentPluginSourceFetch = async (url) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
    calls.push(address)
    if (address.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ sha }), { status: 200 })
    }
    const bytes = await archive
    return new Response(bytes.slice(), { status: 200 })
  }
  return { sha, calls, fetch: fetcher }
}

/** The smallest valid plugin manifest a fixture repository can serve. */
export function agentPluginManifestFixture(name: string, version = "1.0.0") {
  return JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name,
    version,
  })
}
