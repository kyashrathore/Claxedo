import { describe, expect, test } from "bun:test"

const root = new URL("../", import.meta.url)
const mdxFiles = (directory: URL) => Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: directory.pathname }))

describe("framework routes", () => {
  test("preserves every Mintlify suffix beneath /framework", async () => {
    const generated = await mdxFiles(new URL("src/content/docs/framework/", root))
    expect(generated).toEqual((await mdxFiles(new URL("../claxedo-docs/", root))).filter((path) => path !== "index.mdx"))
    expect(await Bun.file(new URL("src/pages/framework.astro", root)).exists()).toBe(true)
    expect(generated).toContain("guides/install.mdx")
    expect(generated).toContain("api/workspace-runtime.mdx")
    expect(generated).toContain("cookbook/01-hello-agent.mdx")
  })

  test("keeps generated content deterministic", () => {
    const result = Bun.spawnSync(["bun", "scripts/sync-framework-docs.ts", "--check"], { cwd: root.pathname })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("Verified 47 deterministic framework pages")
  })
})
