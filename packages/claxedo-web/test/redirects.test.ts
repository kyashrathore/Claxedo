import { beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

type Redirect = { host: string; from: string; aliases: string[]; to: string; status: number; preserveQuery: boolean }
type Manifest = { hostingBinding: { status: string }; redirects: Redirect[]; publicOriginRedirects: Redirect[] }
const root = new URL("../", import.meta.url)
let manifest: Manifest

beforeAll(async () => {
  // process.execPath is the running bun binary — a bare "bun" argv and a
  // URL.pathname cwd (which renders as /D:/...) both fail to spawn on Windows.
  const result = Bun.spawnSync([process.execPath, "scripts/generate-redirects.ts", "--check"], { cwd: fileURLToPath(root) })
  expect(result.exitCode).toBe(0)
  manifest = await Bun.file(new URL("deploy/redirects.json", root)).json()
})

describe("legacy redirect manifest", () => {
  test("maps every source route once with permanent, query-dropping semantics", async () => {
    expect(manifest.redirects).toHaveLength((await Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: fileURLToPath(new URL("../claxedo-docs", root)) }))).length)
    expect(new Set(manifest.redirects.map((redirect) => redirect.from)).size).toBe(manifest.redirects.length)
    expect(manifest.redirects.every((redirect) => redirect.status === 301 && !redirect.preserveQuery)).toBe(true)
    expect(manifest.redirects.find((redirect) => redirect.from === "/")?.to).toBe("https://claxedo.com/framework")
  })

  test("points every redirect at a canonical source route without a redirect chain", async () => {
    for (const redirect of manifest.redirects) {
      const pathname = new URL(redirect.to).pathname
      const slug = pathname.replace(/^\/framework\/?/, "")
      const candidates = slug
        ? [`src/content/docs/framework/${slug}.mdx`, `src/content/docs/framework/${slug}/index.mdx`]
        : ["src/pages/framework.astro"]
      expect((await Promise.all(candidates.map((candidate) => Bun.file(new URL(candidate, root)).exists()))).some(Boolean)).toBe(true)
      expect(manifest.redirects.some((candidate) => new URL(candidate.to).pathname === redirect.from)).toBe(false)
    }
  })

  test("declares the app transition and records the explicit release blocker", () => {
    expect(manifest.publicOriginRedirects).toEqual([{ host: "claxedo.com", from: "/app", aliases: ["/app/"], to: "https://claxedo.com/", status: 301, preserveQuery: false }])
    expect(manifest.hostingBinding.status).toBe("unbound")
  })
})
