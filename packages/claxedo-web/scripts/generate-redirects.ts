import { readdir } from "node:fs/promises"
import path from "node:path"

const source = path.resolve(import.meta.dir, "../../claxedo-docs")
const output = path.resolve(import.meta.dir, "../deploy/redirects.json")
const check = process.argv.includes("--check")

const redirects = (await readdir(source, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
  .map((entry) => path.relative(source, path.join(entry.parentPath, entry.name)).replace(/\.mdx$/, ""))
  .map((slug) => slug === "index" ? "" : slug.replace(/\/index$/, ""))
  .sort()
  .map((slug) => ({
    host: "docs.claxedo.com",
    from: `/${slug}`,
    aliases: slug ? [`/${slug}/`] : [],
    to: `https://claxedo.com/framework${slug ? `/${slug}` : ""}`,
    status: 301,
    preserveQuery: false,
  }))

const manifest = `${JSON.stringify({
  version: 1,
  generatedFrom: "packages/claxedo-docs/**/*.mdx",
  hostingBinding: {
    status: "unbound",
    reason: "The active claxedo.com and docs.claxedo.com edge provider is not declared in this repository. Bind this manifest before DNS cutover.",
  },
  redirects,
  publicOriginRedirects: [{ host: "claxedo.com", from: "/app", aliases: ["/app/"], to: "https://claxedo.com/", status: 301, preserveQuery: false }],
}, null, 2)}\n`

if (check) {
  if ((await Bun.file(output).text()) !== manifest) throw new Error("Redirect manifest is stale")
  console.log(`Verified ${redirects.length} legacy documentation redirects`)
  process.exit(0)
}

await Bun.write(output, manifest)
console.log(`Generated ${redirects.length} legacy documentation redirects`)
