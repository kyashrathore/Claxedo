/**
 * Guard: every doc reference under the tracked doc trees resolves to something real.
 *
 * `docs/` and `public-docs/` are the two repo-root doc trees. Retiring a doc or moving a source file
 * is routine here, so the failure mode this guards against is a retired target leaving a live
 * pointer behind. Two halves, because the docs point at two different kinds of thing:
 *
 *   1. **Relative Markdown links** — the `](target)` of `[label](target)` and `[label]: target`.
 *   2. **Code paths** — a `packages/...` path written as an inline code span, the repo's convention
 *      for "the implementation lives here". These are NOT links, so half (1) never saw them; that is
 *      how 21 dead `packages/**` pointers accumulated across the runbooks while this guard stayed
 *      green through the claxedo-server reorg and the local/cloud package split.
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

/**
 * Prose lines, with fenced code blocks dropped.
 *
 * A fence holds deliberately illustrative material — an example command, a sketch of a file the
 * reader is about to write, a snippet from another repo. Neither half of this guard looks inside
 * one, so an example is never asked to resolve.
 */
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
    result.push({ line: index + 1, text })
  }
  return result
}

/** Inline code spans hold code paths, so link scanning strips them and path scanning reads them. */
const inlineCode = /`([^`\n]+)`/g

function relativeTargets(markdown: string, file: string) {
  const links: Link[] = []
  const add = (raw: string, line: number) => {
    const target = raw.replace(/^<|>$/g, "").trim()
    if (!target) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return
    if (target.startsWith("//") || target.startsWith("#")) return
    links.push({ file, line, target })
  }
  for (const { line, text: raw } of contentLines(markdown)) {
    const text = raw.replace(inlineCode, "")
    const definition = referenceDefinition.exec(text)
    if (definition) add(definition[1], line)
    for (const match of text.matchAll(inlineLink)) add(match[1], line)
  }
  return links
}

/**
 * A literal path into a workspace package: `packages/<name>/<something>`, optionally with a
 * `:line`, `:line-line`, or `:line:column` pointer and an optional trailing `/` for a directory.
 *
 * Deliberately narrow, because a guard that fires on a doc's own prose gets deleted:
 *
 *   - The whole code span must be the path. `packages/claxedo-app under Vite` is prose in a span
 *     and does not match; only `packages/claxedo-app/vite.config.ts` does.
 *   - No `*`, `{`, `}`, `<`, `>`, `$`, `(`, `)`, `,` or whitespace. Those spans are globs
 *     (`src/materializers/*`), brace sets (`harnesses/{claude,codex}/index.ts`), or placeholders
 *     (`packages/<name>/src`) — patterns describing a family of files, not one file that exists.
 *   - It must reach INTO a package. A bare `packages/` or `packages/claxedo-app` is a name, and
 *     directory names are already pinned by every import in the tree.
 */
const codePath = /^packages\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+\/?(?::\d+(?:[-:]\d+)?)?$/

function codePaths(markdown: string, file: string) {
  const references: Link[] = []
  for (const { line, text } of contentLines(markdown)) {
    for (const match of text.matchAll(inlineCode)) {
      const target = match[1].trim()
      if (!codePath.test(target)) continue
      references.push({ file, line, target })
    }
  }
  return references
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

/**
 * `docs/plans/**` is exempt from the code-path half, and only from that half.
 *
 * A plan's whole job is to name files that do not exist yet — its Files section literally reads
 * `Create: packages/x/src/y.ts`. Enforcing existence there would turn every new plan red on the
 * commit that adds it, and the first fix anyone reached for would be to switch the guard off, which
 * costs the runbooks the coverage this exists to give them. So the exemption is a category, not a
 * carve-out for an awkward file: plans are the one tree whose convention is forward-looking.
 *
 * Plans keep the link half in full. A plan may invent a source path; it may not link to a doc that
 * was deleted. And a plan's paths do get checked eventually — by this guard, once the unit lands
 * and the plan's claims are copied into `docs/tech-docs/` or `public-docs/`.
 */
const forwardLookingRoots = ["docs/plans/"]
const enforcesCodePaths = (file: string) => !forwardLookingRoots.some((root) => file.startsWith(root))

const broken: Link[] = []
const dead: Link[] = []
let checked = 0
let pathsChecked = 0

for (const root of roots) {
  for (const file of await markdownFiles(root)) {
    const markdown = await Bun.file(path.join(repoRoot, file)).text()
    for (const link of relativeTargets(markdown, file)) {
      checked++
      // `foo.ts:120` and `foo.ts:120:9` are file:line pointers; only the file half is checkable.
      const target = link.target.split(/[#?]/)[0].replace(/:\d+(:\d+)?$/, "")
      const found = await Promise.all(bases(file, target).map((base) => exists(path.resolve(base, target))))
      if (found.some(Boolean)) continue
      broken.push(link)
    }
    if (!enforcesCodePaths(file)) continue
    for (const reference of codePaths(markdown, file)) {
      pathsChecked++
      // Code paths are always repo-root-relative: `packages/...` is the repo's citation convention.
      const target = reference.target.replace(/:\d+(?:[-:]\d+)?$/, "").replace(/\/$/, "")
      if (await exists(path.resolve(repoRoot, target))) continue
      dead.push(reference)
    }
  }
}

if (broken.length) {
  for (const link of broken) console.error(`[doc-links] ${link.file}:${link.line} -> ${link.target} (no such file)`)
  console.error(`[doc-links] ${broken.length} broken relative link${broken.length === 1 ? "" : "s"} of ${checked} checked`)
}

if (dead.length) {
  for (const reference of dead) {
    console.error(`[doc-paths] ${reference.file}:${reference.line} -> ${reference.target} (no such path in the repository)`)
  }
  console.error(
    `[doc-paths] ${dead.length} dead code path${dead.length === 1 ? "" : "s"} of ${pathsChecked} checked. ` +
      `Point each at the file that owns the behaviour today, or drop the path and describe it in prose.`,
  )
}

if (broken.length || dead.length) process.exit(1)

console.log(
  `Verified ${checked} relative documentation links and ${pathsChecked} packages/ code paths across ${roots.join(", ")}`,
)
