import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const TEXT_EXTENSIONS = new Set([".md", ".sh", ".txt"])

function isTextImport(url, context) {
  if (context.importAttributes?.type === "text") return true
  const parsed = new URL(url)
  if (parsed.search === "?raw") return true
  return [...TEXT_EXTENSIONS].some((extension) => parsed.pathname.endsWith(extension))
}

function filePath(url) {
  const parsed = new URL(url)
  parsed.search = ""
  parsed.hash = ""
  return fileURLToPath(parsed)
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !isTextImport(url, context)) return nextLoad(url, context)
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(await readFile(filePath(url), "utf8"))};`,
  }
}
