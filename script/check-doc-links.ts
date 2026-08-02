/**
 * Guard: every relative Markdown link under the tracked doc trees resolves to a real file.
 *
 * `docs/` and `public-docs/` are the two repo-root doc trees. Retiring a doc is routine here, so
 * the failure mode this guards against is a retired target leaving a live pointer behind.
 *
 * Run: `bun run docs:check-links`
 */

import { readdir } from "node:fs/promises"
import path from "node:path"

const roots = ["docs", "public-docs"] as const
const repoRoot = path.resolve(import.meta.dir, "..")

type Link = { file: string; line: number; target: string }

/** Markdown link/image targets: the `](...)` half of `[label](target)` and `![alt](target)`. */
const inlineLink = /!?\]\(\s*(<[^>]*>|[^()\s]*)/g
/** Reference definitions: `[label]: target`. */
const referenceDefinition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/

/** Fenced code blocks hold example links that are not expected to resolve. */
function contentLines(markdown: string) {
  const lines = markdown.split("\n")
  const result: { line: number; text: string }[] = []
  let fence = ""
  for (const [index, text] of lines.entries()) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(text)
    if (fence) {
      if (opener && opener[1].startsWith(fence[0]) && opener[1].length >= fence.length) fence = ""
      continue
    }
    if (opener) {
      fence = opener[1]
      continue
    }
    result.push({ line: index + 1, text: text.replace(/`[^`]*`/g, "") })
  }
  return result
}

function relativeTargets(markdown: string, file: string) {
  const links: Link[] = []
  const add = (raw: string, line: number) => {
    const target = raw.replace(/^<|>$/g, "").trim()
    if (!target) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return
    if (target.startsWith("//") || target.startsWith("#")) return
    links.push({ file, line, target })
  }
  for (const { line, text } of contentLines(markdown)) {
    const definition = referenceDefinition.exec(text)
    if (definition) add(definition[1], line)
    for (const match of text.matchAll(inlineLink)) add(match[1], line)
  }
  return links
}

async function markdownFiles(root: string) {
  const entries = await readdir(path.join(repoRoot, root), { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name)))
    .sort()
}

async function exists(candidate: string) {
  if (await Bun.file(candidate).exists()) return true
  // Directory targets resolve through the filesystem, not Bun.file.
  return await readdir(candidate).then(() => true, () => false)
}

/**
 * Doc-relative is the default base. A bare path such as `packages/x/y.ts` is the repo's code-reference
 * convention and is resolved from the repo root as well, so code pointers are checked for existence
 * without forcing every plan doc to spell out `../../packages/...`. Anything explicitly anchored with
 * `./`, `../`, or `/` only ever resolves doc-relative.
 */
function bases(file: string, target: string) {
  const docRelative = path.resolve(repoRoot, path.dirname(file))
  if (/^\.{0,2}\//.test(target)) return [docRelative]
  return [docRelative, repoRoot]
}

const broken: Link[] = []
let checked = 0

for (const root of roots) {
  for (const file of await markdownFiles(root)) {
    for (const link of relativeTargets(await Bun.file(path.join(repoRoot, file)).text(), file)) {
      checked++
      // `foo.ts:120` and `foo.ts:120:9` are file:line pointers; only the file half is checkable.
      const target = link.target.split(/[#?]/)[0].replace(/:\d+(:\d+)?$/, "")
      const found = await Promise.all(bases(file, target).map((base) => exists(path.resolve(base, target))))
      if (found.some(Boolean)) continue
      broken.push(link)
    }
  }
}

if (broken.length) {
  for (const link of broken) console.error(`[doc-links] ${link.file}:${link.line} -> ${link.target} (no such file)`)
  console.error(`[doc-links] ${broken.length} broken relative link${broken.length === 1 ? "" : "s"} of ${checked} checked`)
  process.exit(1)
}

console.log(`Verified ${checked} relative documentation links across ${roots.join(", ")}`)
