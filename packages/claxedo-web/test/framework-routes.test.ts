import { describe, expect, test } from "bun:test"

const root = new URL("../", import.meta.url)
const mdxFiles = (directory: URL) => Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: directory.pathname }))

describe("framework routes", () => {
  test("preserves every Mintlify suffix beneath /framework", async () => {
    const generated = await mdxFiles(new URL("src/content/docs/framework/", root))
    expect(generated).toEqual((await mdxFiles(new URL("../claxedo-docs/", root))).filter((file) => file !== "index.mdx"))
    expect(await Bun.file(new URL("src/pages/framework.astro", root)).exists()).toBe(true)
    expect(generated).toContain("guides/install.mdx")
    expect(generated).toContain("api/workspace-runtime.mdx")
    // The docs refocus (84480e0c6) deleted the cookbook section; the spot-check
    // now pins a page from the surviving concepts set instead.
    expect(generated).toContain("concepts/workspace-host.mdx")
  })

})
