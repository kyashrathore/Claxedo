import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const assetsDir = path.resolve(import.meta.dir, "../out/renderer/assets")

function jsChunks(): string[] {
  if (!fs.existsSync(assetsDir)) return []
  return fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith(".js"))
}

/** Strip the content hash and extension, e.g. "cpp-zh2ePAE_.js" → "cpp" */
function chunkBaseName(file: string): string {
  return file.replace(/-[A-Za-z0-9_]+\.js$/, "")
}

test("no duplicate JS chunks in renderer build", () => {
  const chunks = jsChunks()
  if (chunks.length === 0) throw new Error(`no JS chunks found in ${assetsDir} — run build first`)

  const counts = new Map<string, string[]>()
  for (const file of chunks) {
    const base = chunkBaseName(file)
    const list = counts.get(base) ?? []
    list.push(file)
    counts.set(base, list)
  }

  const duplicates = [...counts.entries()]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))

  if (duplicates.length > 0) {
    const summary = duplicates
      .map(([name, files]) => `  ${name} (×${files.length}): ${files.join(", ")}`)
      .join("\n")
    expect.unreachable(
      `${duplicates.length} chunk names appear more than once — multi-entry dedup is broken:\n${summary}`,
    )
  }
})

test("only one shiki bundledLanguagesInfo registry in main bundle", () => {
  const chunks = jsChunks()
  if (chunks.length === 0) throw new Error(`no JS chunks found in ${assetsDir} — run build first`)

  const mainChunk = chunks.find((f) => chunkBaseName(f) === "main")
  if (!mainChunk) throw new Error("main chunk not found in build output")

  const content = fs.readFileSync(path.join(assetsDir, mainChunk), "utf8")

  // Two registries means shiki is bundled twice — once via direct import, once via @pierre/diffs.
  // marked.tsx imports { bundledLanguages } from "shiki" directly AND uses
  // { getSharedHighlighter } from "@pierre/diffs" which re-bundles shiki internally.
  // This creates two parallel sets of language grammar chunks (~15 MB wasted).
  const registryCount = (content.match(/bundledLanguagesInfo/g) || []).length

  // bundledLanguagesInfo should appear at most a few times (definition + references)
  // from a single instance. Two separate registries (bundledLanguagesInfo$1 and
  // bundledLanguagesInfo) indicate duplicate bundling.
  const hasRenamedRegistry = content.includes("bundledLanguagesInfo$1")
  expect(hasRenamedRegistry).toBe(false)
})
