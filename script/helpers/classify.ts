/**
 * Movability analysis: can a helper be moved into a shared package at all?
 *
 * This is a mechanical question, not a judgement one, and answering it first
 * keeps expensive review off the helpers that could never move. A helper that
 * reads a module-local declaration is pinned to its module no matter how
 * generic it looks; a helper whose only free identifiers are globals can move
 * with nothing but a copy.
 *
 * Free identifiers are resolved against three things the file itself declares:
 * its imports, its top-level names, and the bindings inside the helper. Any
 * identifier that resolves to none of those is a global or a binding the scan
 * did not model — both harmless, because only matches against module-local
 * names and imports change the verdict. Deliberately approximate in the
 * direction that cannot invent a false "movable".
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { inventory, scan, REPO_ROOT, type Helper } from "./extract.ts"

export type Movability =
  /** Only globals. Copy it and it works. */
  | "pure"
  /** Needs node builtins or third-party packages a shared package can also depend on. */
  | "portable-deps"
  /** Needs a sibling module in its own package; moves only if that moves too. */
  | "relative-coupled"
  /** Reads a declaration from its own module. Pinned. */
  | "module-coupled"

export type Classified = Helper & {
  movability: Movability
  /** Module specifiers the helper needs. */
  deps: string[]
  /** Module-local names the helper reads. Non-empty means it cannot move. */
  coupledTo: string[]
}

const KEYWORDS = new Set(
  ("await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static get set of as satisfies keyof infer readonly asserts is any unknown never string number boolean object symbol bigint undefined type interface namespace declare abstract implements private protected public").split(
    " ",
  ),
)

/** Identifiers in code positions, excluding property accesses and object keys. */
function referenced(text: string, start: number, end: number, s: ReturnType<typeof scan>): Set<string> {
  const out = new Set<string>()
  let i = start
  while (i < end) {
    if (!s.isCode[i] || s.isComment[i]) {
      i++
      continue
    }
    if (!/[A-Za-z_$]/.test(text[i]!)) {
      i++
      continue
    }
    let j = i
    while (j < end && /[\w$]/.test(text[j]!)) j++
    const word = text.slice(i, j)
    // Property access: `a.b` and `a?.b` — `b` is not a free identifier.
    let k = i - 1
    while (k >= start && /\s/.test(text[k]!)) k--
    const isProperty = text[k] === "."
    // Object literal key: `{ foo: 1 }` / `, foo: 1`.
    let m = j
    while (m < end && /\s/.test(text[m]!)) m++
    let n = i - 1
    while (n >= start && /\s/.test(text[n]!)) n--
    const isKey = text[m] === ":" && (text[n] === "{" || text[n] === ",")
    if (!isProperty && !isKey && !KEYWORDS.has(word)) out.add(word)
    i = j
  }
  return out
}

/** Names the helper binds itself: its parameters and anything declared in its body. */
function boundNames(body: string): Set<string> {
  const bound = new Set<string>()
  const open = body.indexOf("(")
  if (open !== -1) {
    let d = 0
    let close = -1
    for (let i = open; i < body.length; i++) {
      if (body[i] === "(") d++
      else if (body[i] === ")") {
        d--
        if (d === 0) {
          close = i
          break
        }
      }
    }
    if (close !== -1) {
      // Within each comma-separated parameter, names before the first `:` are
      // bindings and names after it are types — which stay free identifiers.
      let depth = 0
      let current = ""
      for (const ch of `${body.slice(open + 1, close)},`) {
        if ("([{<".includes(ch)) depth++
        else if (")]}>".includes(ch)) depth--
        if (ch === "," && depth === 0) {
          const head = current.split(":")[0] ?? ""
          for (const id of head.match(/[A-Za-z_$][\w$]*/g) ?? []) bound.add(id)
          current = ""
          continue
        }
        current += ch
      }
    }
  }
  for (const m of body.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!)
  for (const m of body.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g))
    for (const id of m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) bound.add(id)
  // Parameters of nested arrows and callbacks, which are bindings, not refs.
  for (const m of body.matchAll(/\(([^()]*)\)\s*=>/g))
    for (const seg of m[1]!.split(",")) {
      const head = seg.split(":")[0] ?? ""
      for (const id of head.match(/[A-Za-z_$][\w$]*/g) ?? []) bound.add(id)
    }
  for (const m of body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[1]!)
  for (const m of body.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]!)
  return bound
}

type FileFacts = { imports: Map<string, string>; topLevel: Set<string> }

function fileFacts(text: string): FileFacts {
  const imports = new Map<string, string>()
  const topLevel = new Set<string>()
  for (const m of text.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
    const spec = m[3]!
    for (const id of (m[2] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (id === "type" || id === "as") continue
      imports.set(id, spec)
    }
  }
  for (const m of text.matchAll(
    /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s+|const\s+|let\s+|var\s+|class\s+|type\s+|interface\s+|enum\s+)([A-Za-z_$][\w$]*)/gm,
  ))
    topLevel.add(m[1]!)
  return { imports, topLevel }
}

function kindOf(spec: string): "builtin" | "relative" | "workspace" | "external" {
  if (spec.startsWith("node:")) return "builtin"
  if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~")) return "relative"
  if (spec.startsWith("@claxedo/") || spec.startsWith("@opencode-ai/")) return "workspace"
  return "external"
}

export function classify(): Classified[] {
  const helpers = inventory()
  const byFile = new Map<string, Helper[]>()
  for (const h of helpers) {
    const list = byFile.get(h.file) ?? []
    list.push(h)
    byFile.set(h.file, list)
  }

  const out: Classified[] = []
  for (const [file, list] of byFile) {
    const abs = path.join(REPO_ROOT, file)
    let text: string
    try {
      text = fs.readFileSync(abs, "utf8")
    } catch {
      continue
    }
    const s = scan(text)
    const facts = fileFacts(text)
    for (const h of list) {
      const refs = referenced(text, h.start, h.end, s)
      const bound = boundNames(h.body)
      const deps = new Set<string>()
      const coupledTo: string[] = []
      for (const ref of refs) {
        if (ref === h.name || bound.has(ref)) continue
        const imported = facts.imports.get(ref)
        if (imported) {
          deps.add(imported)
          continue
        }
        if (facts.topLevel.has(ref)) coupledTo.push(ref)
      }
      const kinds = new Set([...deps].map(kindOf))
      const movability: Movability = coupledTo.length
        ? "module-coupled"
        : kinds.has("relative")
          ? "relative-coupled"
          : deps.size
            ? "portable-deps"
            : "pure"
      out.push({ ...h, movability, deps: [...deps].sort(), coupledTo: coupledTo.sort() })
    }
  }
  return out
}

if (import.meta.main) {
  const all = classify()
  const by = (m: Movability) => all.filter((h) => h.movability === m)
  process.stderr.write(
    [
      `${all.length} helpers`,
      `  pure             ${by("pure").length}`,
      `  portable-deps    ${by("portable-deps").length}`,
      `  relative-coupled ${by("relative-coupled").length}`,
      `  module-coupled   ${by("module-coupled").length}`,
      "",
    ].join("\n"),
  )
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(all))
}
