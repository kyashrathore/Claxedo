/**
 * Helper-function inventory for the whole workspace.
 *
 * This exists because the expensive form of helper duplication in this repo is
 * not copy-paste — it is DIVERGENCE UNDER A SHARED NAME. `isRecord` is defined
 * ten times in six different ways, three of which answer `true` for an array;
 * `positiveInteger` is defined nine times in nine different ways, and two
 * siblings in the same directory disagree on whether it returns a number or a
 * string. Nothing in the repo could see that, because no tool had an inventory
 * of what a "helper" is.
 *
 * A helper here is a FUNCTION DECLARED AT THE TOP LEVEL OF A MODULE — the scope
 * an agent reaches for when it wants a small utility and cannot find one. A
 * function nested inside another is a closure over local state, not a candidate
 * for sharing, so it is deliberately not counted. Top level is determined by
 * brace depth from a scanner that tracks strings, template substitutions and
 * comments, because a `{` inside a string must not shift the depth.
 *
 * The scanner is hand-rolled rather than delegated to the TypeScript compiler
 * API on purpose: `typescript` in this workspace is 7.x, the Go rewrite, whose
 * JS module exports only `version`. A ratchet that runs on every push should
 * not acquire a parser dependency to answer a question this shallow.
 *
 * Bodies are normalized by removing comments and collapsing whitespace, so
 * formatting and comment edits are invisible while identifiers and structure
 * stay significant: two helpers hash the same only when they behave the same.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const PACKAGES = path.join(REPO_ROOT, "packages")

/** Directories that never contain reviewed source. */
export const SKIP_DIR = new Set(["node_modules", "dist", "out", "build", "coverage", ".git", "storybook-static", ".artifacts", ".turbo"])
const SKIP_FILE = /\.(test|vitest|spec|bench)\.(ts|tsx)$|\.d\.ts$/

/**
 * Source that ships versus source that supports it. Both are scanned — a
 * duplicated helper in a deploy script has bitten this repo before — but the
 * two are reported separately so a perf-harness clone never outranks a
 * divergent narrowing helper in shipped code.
 */
const SUPPORT_PATH = /(^|\/)(scripts?|bench|perf-harness|e2e|test-support|storybook)(\/|$)/

export type Helper = {
  pkg: string
  file: string
  line: number
  name: string
  exported: boolean
  shipped: boolean
  loc: number
  size: number
  hash: string
  body: string
  /**
   * Declared inside another function. Not part of the shared-helper inventory —
   * a closure over local state is not a candidate for sharing — but a canonical
   * name redefined at any depth is still a redefinition, so `verify.ts` reads
   * these for its RESERVED rule.
   */
  nested: boolean
  /** Character offsets of the declaration in its file, for a second analysis pass. */
  start: number
  end: number
}

/**
 * Every shipped/support `.ts`/`.tsx` under `packages/`.
 *
 * Test, spec and bench files are excluded by default: a helper declared inside
 * one is fixture scaffolding, not a candidate for sharing. Pass `tests: true`
 * when the question is who *imports* a name rather than who declares it —
 * deleting an exported helper breaks a test importer exactly as hard as a
 * source importer, and the default walk cannot see it.
 */
export function* sourceFiles(options: { tests?: boolean } = {}): Generator<{ pkg: string; abs: string }> {
  for (const pkg of fs.readdirSync(PACKAGES).sort()) {
    const base = path.join(PACKAGES, pkg)
    if (!fs.statSync(base).isDirectory()) continue
    const stack = [base]
    while (stack.length) {
      const dir = stack.pop()!
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIR.has(entry.name) && !entry.name.startsWith("dist")) stack.push(path.join(dir, entry.name))
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (entry.name.endsWith(".d.ts")) continue
        if (!options.tests && SKIP_FILE.test(entry.name)) continue
        yield { pkg, abs: path.join(dir, entry.name) }
      }
    }
  }
}

/**
 * Positions in `text` that begin a statement, paired with the brace depth at
 * every offset so a declaration's extent can be found by scanning to the point
 * where depth returns to where it began.
 */
export type Scan = {
  topLevelStarts: number[]
  /**
   * Statement starts at depth > 0 whose first character could begin a
   * declaration. Only the seven keywords `DECL` can start are kept, so this
   * stays a small list rather than every statement in the repository.
   */
  nestedStarts: number[]
  depthAt: Int32Array
  /** Parenthesis depth, so a `{` inside a parameter list is not mistaken for the body. */
  parenAt: Int32Array
  lineAt: Int32Array
  isComment: Uint8Array
  /** Characters the scanner read as code — not string, template, regex or comment text. */
  isCode: Uint8Array
}

export function scan(text: string): Scan {
  const depthAt = new Int32Array(text.length + 1)
  const lineAt = new Int32Array(text.length + 1)
  // Which characters are comment text. The scanner already knows this exactly;
  // a regex that strips `//` cannot, and will eat the tail of any body holding
  // a string like "//" or "https://".
  const isComment = new Uint8Array(text.length)
  const isCode = new Uint8Array(text.length)
  const parenAt = new Int32Array(text.length + 1)
  const topLevelStarts: number[] = []
  const nestedStarts: number[] = []
  let depth = 0
  let paren = 0
  let line = 1
  let atStatementStart = true
  // Template literals nest: `a${ {b:1} }c` re-enters template mode on close.
  const templateStack: number[] = []
  let i = 0
  let mode: "code" | "line-comment" | "block-comment" | "string" | "template" | "regex" = "code"
  let quote = ""
  // A `/` is a regex only where a value may begin. Without this, `/["']/`
  // flips the scanner into string mode and the rest of the body is misread.
  let prevSignificant = ""
  let inCharClass = false
  // The scanner advances two characters at a time for `${`, escapes and comment
  // markers. Every index it steps over must still be filled, or it keeps the
  // Int32Array default of 0 and `extent` reads that as a return to top level —
  // truncating every body that contains a template substitution.
  let filled = 0

  while (i < text.length) {
    while (filled <= i) {
      depthAt[filled] = depth
      parenAt[filled] = paren
      isCode[filled] = mode === "code" ? 1 : 0
      lineAt[filled] = line
      if (text[filled] === "\n") line++
      filled++
    }
    const c = text[i]!
    const next = text[i + 1]

    if (mode === "line-comment") {
      if (c === "\n") mode = "code"
      else isComment[i] = 1
      i++
      continue
    }
    if (mode === "block-comment") {
      isComment[i] = 1
      if (c === "*" && next === "/") {
        isComment[i + 1] = 1
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === "string") {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === quote) mode = "code"
      i++
      continue
    }
    if (mode === "regex") {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === "[") inCharClass = true
      else if (c === "]") inCharClass = false
      else if (c === "/" && !inCharClass) mode = "code"
      i++
      continue
    }
    if (mode === "template") {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === "`") {
        mode = "code"
        i++
        continue
      }
      if (c === "$" && next === "{") {
        templateStack.push(depth)
        depth++
        mode = "code"
        i += 2
        continue
      }
      i++
      continue
    }

    // mode === "code"
    if (c === "/" && next !== "/" && next !== "*" && (prevSignificant === "" || "(,=:[!&|?{;".includes(prevSignificant))) {
      mode = "regex"
      inCharClass = false
      atStatementStart = false
      prevSignificant = "/"
      i++
      continue
    }
    if (c === "/" && next === "/") {
      mode = "line-comment"
      isComment[i] = 1
      isComment[i + 1] = 1
      i += 2
      continue
    }
    if (c === "/" && next === "*") {
      mode = "block-comment"
      isComment[i] = 1
      isComment[i + 1] = 1
      i += 2
      continue
    }
    if (c === '"' || c === "'") {
      mode = "string"
      quote = c
      atStatementStart = false
      prevSignificant = c
      i++
      continue
    }
    if (c === "`") {
      mode = "template"
      atStatementStart = false
      i++
      continue
    }
    if (c === "(") {
      paren++
      atStatementStart = false
      prevSignificant = c
      i++
      continue
    }
    if (c === ")") {
      paren--
      atStatementStart = false
      prevSignificant = c
      i++
      continue
    }
    if (c === "{") {
      depth++
      atStatementStart = true
      prevSignificant = c
      i++
      continue
    }
    if (c === "}") {
      prevSignificant = c
      depth--
      if (templateStack.length && templateStack[templateStack.length - 1] === depth) {
        templateStack.pop()
        mode = "template"
      }
      atStatementStart = true
      i++
      continue
    }
    if (c === ";" || c === "\n") {
      atStatementStart = true
      if (c === ";") prevSignificant = c
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    if (atStatementStart) {
      if (depth === 0) topLevelStarts.push(i)
      else if (DECL_FIRST_CHAR.has(c)) nestedStarts.push(i)
    }
    atStatementStart = false
    prevSignificant = c
    i++
  }
  depthAt[text.length] = depth
  parenAt[text.length] = paren
  lineAt[text.length] = line
  return { topLevelStarts, nestedStarts, depthAt, parenAt, lineAt, isComment, isCode }
}

/**
 * First characters of every alternative `DECL` accepts: `export`, `declare`,
 * `async`, `function`, `const`, `let`, `var`. Kept beside the regex because it
 * must be widened whenever that is.
 */
const DECL_FIRST_CHAR = new Set(["e", "d", "a", "f", "c", "l", "v"])

const DECL =
  /^(?<exp>export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s+(?<fn>[A-Za-z_$][\w$]*)|(?:const|let|var)\s+(?<v>[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=\s*(?<init>[\s\S]{0,40}))/

/** Does the initializer of a `const x = …` start a function? */
function initializerIsFunction(init: string): boolean {
  const head = init.replace(/^\s*/, "")
  if (/^(async\s+)?function\b/.test(head)) return true
  if (/^(async\s*)?\(/.test(head)) return true
  if (/^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(head)) return true
  return false
}

/**
 * Where the declaration beginning at `start` ends.
 *
 * The body brace is the first `{` that appears in code at parenthesis depth
 * zero — an inline object type in a parameter list (`(event: { id: string })`)
 * opens and closes a brace before the body ever starts, and treating that as
 * the body truncates the helper at its own signature.
 *
 * A concise arrow (`const f = (a) => a + 1`) has no body brace, so it ends at
 * the first newline where parentheses are balanced and the line does not end on
 * an operator that demands a continuation.
 */
function extent(text: string, start: number, s: Scan): number {
  const baseParen = s.parenAt[start]!
  const baseDepth = s.depthAt[start]!

  // Skip past the parameter list before looking for the body. A generic
  // constraint (`<T extends { id: string }>`) puts a brace at the same paren
  // depth as the body, and mistaking it for the body cuts the helper at its
  // own type parameters.
  let afterParams = start
  for (let j = start; j < text.length; j++) {
    if (!s.isCode[j] || s.isComment[j]) continue
    if (text[j] === "\n" && s.parenAt[j] === baseParen && s.depthAt[j] === baseDepth && j > start) {
      const line = text.slice(text.lastIndexOf("\n", j - 1) + 1, j).trimEnd()
      if (line && !/(=>|[=+\-*/%<>&|,.?:([{]|\breturn\b)$/.test(line)) break
    }
    if (text[j] === "(" && s.parenAt[j] === baseParen) {
      for (let k = j + 1; k < text.length; k++) {
        if (s.parenAt[k] === baseParen && s.isCode[k] && !s.isComment[k]) {
          afterParams = k
          break
        }
      }
      break
    }
  }

  let i = afterParams
  for (; i < text.length; i++) {
    if (!s.isCode[i] || s.isComment[i]) continue
    const c = text[i]
    if (c === "{" && s.parenAt[i] === baseParen) {
      // Body opener found: run to where brace depth returns to where it began.
      for (let j = i + 1; j < text.length; j++) {
        if (s.depthAt[j] === baseDepth && s.isCode[j] && !s.isComment[j]) return j + 1
      }
      return text.length
    }
    if (c === "\n" && s.parenAt[i] === baseParen && s.depthAt[i] === baseDepth) {
      const line = text.slice(text.lastIndexOf("\n", i - 1) + 1, i).trimEnd()
      if (line && !/(=>|[=+\-*/%<>&|,.?:([{]|\breturn\b|\bawait\b)$/.test(line)) return i
    }
    if (c === ";" && s.parenAt[i] === baseParen && s.depthAt[i] === baseDepth) return i + 1
  }
  return text.length
}

/** Drop the characters the scanner identified as comment text. */
function stripComments(text: string, start: number, end: number, s: Scan): string {
  let out = ""
  for (let i = start; i < end; i++) if (!s.isComment[i]) out += text[i]
  return out
}

/**
 * Rewrite parameter names to positional tokens.
 *
 * `isRecord(value)` and `isRecord(input)` are the same helper written twice, not
 * two implementations, and the divergence rule must not fire on the difference.
 * Only the parameter list is alpha-renamed: everything a caller can observe —
 * the checks performed, the values returned, the types asserted — stays
 * significant, so two bodies still hash apart the moment they behave apart.
 */
/**
 * Squeeze a body down for storage without changing what it says.
 *
 * Indentation is noise, so it goes. Newlines are not: TypeScript terminates a
 * statement at a line break, and collapsing every run of whitespace to a space
 * welds `return` onto the line below it. That is how a correct
 * `if (ms <= 0) return` / `await sleep(ms)` was stored as
 * `if (ms <= 0) return await sleep(ms)` — a body that reads as the exact
 * inverse of the code it came from. Every reader of this field, human or
 * agent, treats it as source, so it has to stay honest about statement
 * boundaries.
 */
function normalizeBody(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
}

function alphaNormalize(body: string): string {
  const open = body.indexOf("(")
  if (open === -1) return body
  let depth = 0
  let close = -1
  for (let i = open; i < body.length; i++) {
    if (body[i] === "(") depth++
    else if (body[i] === ")") {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return body
  const params = body.slice(open + 1, close)
  const names: string[] = []
  let d = 0
  let current = ""
  for (const ch of `${params},`) {
    if ("([{<".includes(ch)) d++
    else if (")]}>".includes(ch)) d--
    if (ch === "," && d === 0) {
      const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(current)
      if (m?.[1]) names.push(m[1])
      current = ""
      continue
    }
    current += ch
  }
  let out = body
  names.forEach((name, index) => {
    out = out.replace(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g"), `_p${index}`)
  })
  return out
}

/**
 * Top-level function declarations across the workspace.
 *
 * `nested` additionally returns functions declared inside other functions.
 * These are excluded by default and must stay excluded from any count the
 * baseline pins: they are closures over local state, not candidates for
 * sharing, and folding them in would move `totalHelpers` and every divergence
 * floor with it. They matter only to the RESERVED rule, which asks whether a
 * canonical name was redefined — a question depth does not change.
 */
export function inventory(options: { nested?: boolean } = {}): Helper[] {
  const helpers: Helper[] = []
  for (const { pkg, abs } of sourceFiles()) {
    let text: string
    try {
      text = fs.readFileSync(abs, "utf8")
    } catch {
      continue
    }
    const s = scan(text)
    const rel = path.relative(REPO_ROOT, abs)
    const shipped = !SUPPORT_PATH.test(rel.replace(/^packages\/[^/]+\//, ""))
    const starts = options.nested
      ? [...s.topLevelStarts.map((v) => [v, false] as const), ...s.nestedStarts.map((v) => [v, true] as const)]
      : s.topLevelStarts.map((v) => [v, false] as const)
    for (const [start, nested] of starts) {
      const window = text.slice(start, start + 400)
      const m = DECL.exec(window)
      if (!m?.groups) continue
      const name = m.groups.fn ?? m.groups.v
      if (!name) continue
      if (m.groups.v && !initializerIsFunction(m.groups.init ?? "")) continue
      const end = extent(text, start, s)
      const raw = text.slice(start, end)
      const body = normalizeBody(stripComments(text, start, end, s))
      if (!body) continue
      // Hash the flattened form, store the line-preserving one. Two copies of
      // the same helper, one wrapped across four lines and one on a single
      // line, are one implementation; a reader still needs the line breaks to
      // see where each statement ends.
      const shape = alphaNormalize(body.replace(/\s+/g, " "))
      helpers.push({
        pkg,
        file: rel,
        line: s.lineAt[start]!,
        name,
        exported: !!m.groups.exp,
        shipped,
        loc: raw.split("\n").length,
        size: body.length,
        hash: createHash("sha1").update(shape).digest("hex").slice(0, 12),
        body,
        nested,
        start,
        end,
      })
    }
  }
  return helpers
}

if (import.meta.main) {
  const all = inventory({ nested: process.argv.includes("--nested") })
  process.stderr.write(`${all.length} helpers across ${new Set(all.map((h) => h.pkg)).size} packages\n`)
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(all, null, 2))
}
