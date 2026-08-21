import { describe, expect, test } from "bun:test"
import { sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
// fileURLToPath, not URL.pathname (renders as /D:/... on Windows), and the
// scan emits host separators while the assertions below pin URL-style slugs.
const mdxFiles = async (directory: URL) =>
  (await Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: fileURLToPath(directory) }))).map((file) => file.split(sep).join("/"))

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
