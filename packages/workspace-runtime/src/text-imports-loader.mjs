import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

function isTextImport(url, context) {
  if (context.importAttributes?.type === "text") return true
  const parsed = new URL(url)
  if (parsed.search === "?raw") return true
  return parsed.pathname.endsWith(".template.sh") || parsed.pathname.endsWith(".template.txt")
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !isTextImport(url, context)) return nextLoad(url, context)
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(await readFile(fileURLToPath(new URL(url)), "utf8"))};`,
  }
}
