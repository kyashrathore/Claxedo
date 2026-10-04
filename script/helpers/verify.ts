/**
 * `verify:helpers` — the ratchet that stops helper duplication from growing.
 *
 * Three rules, each aimed at a failure this repo has actually taken:
 *
 *   RESERVED   A name owned by a canonical module may not be redefined
 *              anywhere else. This is the rule that makes canonicalization
 *              stick: without it, consolidating `isRecord` into one place
 *              lasts exactly until the next agent writes a local one because
 *              searching was more expensive than typing. "Anywhere" includes
 *              inside another function: `providers/layout.tsx` held a nested
 *              `const isRecord` that the top-level inventory could not see.
 *
 *   DIVERGENCE A name already defined in several files may not grow a new
 *              implementation. Duplication is tolerable; duplication where the
 *              copies disagree is how `isRecord` came to answer `true` for an
 *              array in three of its six definitions.
 *
 *   TWINS      A duplication that is deliberate must be declared and must stay
 *              byte-identical. `replay-sanitize.ts` is duplicated on purpose
 *              between the app and the runtime, with a comment promising the
 *              two "cannot drift silently". Nothing enforced that promise; the
 *              twin manifest does.
 *
 * BROKEN MEASUREMENT FAILS. A walk that found no helpers would satisfy every
 * rule and read as a clean repo, so an implausibly small inventory is reported
 * as a failure before any rule runs.
 *
 *   bun script/helpers/verify.ts              # check
 *   bun script/helpers/verify.ts --baseline   # re-record after a reviewed change
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isFiniteNumber, isRecord } from "../../packages/claxedo-helpers/src/guards.ts"
import { inventory, REPO_ROOT, type Helper } from "./extract.ts"
import { readCanonicalManifest } from "./manifest.ts"

const BASELINE = path.join(import.meta.dirname, "helpers-baseline.json")

/** Below this, the inventory is not believable and the run is a measurement failure. */
const MIN_PLAUSIBLE_HELPERS = 5000
/**
 * A body cut mid-token means the extractor lost the end of a helper, so its
 * hash covers a prefix and any divergence past the cut is invisible. That
 * degrades every rule below while still reporting green, so it is capped.
 */
const MAX_TRUNCATED_BODIES = 5
const TRUNCATED = /(\$\{|[([,=.?:&|+\-*/]|=>|\breturn\b|\bawait\b)$/
/** Bodies shorter than this are punctuation, not a shared helper. */
const MIN_MEANINGFUL_BODY = 60

type Baseline = {
  totalHelpers: number
  divergentNames: Record<string, number>
  clonedCopies: number
}

type Finding = { rule: string; where: string; detail: string }

/** No baseline yet reads as an empty one, so the first run reports every divergent name. */
function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE)) return { totalHelpers: 0, divergentNames: {}, clonedCopies: 0 }
  const raw = readJsonFile(BASELINE)
  if (!isRecord(raw) || !isFiniteNumber(raw.totalHelpers) || !isFiniteNumber(raw.clonedCopies) || !isRecord(raw.divergentNames)) {
    throw new Error(`${BASELINE}: not a helpers baseline`)
  }
  const divergentNames: Record<string, number> = {}
  for (const [name, impls] of Object.entries(raw.divergentNames)) {
    if (!isFiniteNumber(impls)) throw new Error(`${BASELINE}: divergentNames.${name} is not a count`)
    divergentNames[name] = impls
  }
  return { totalHelpers: raw.totalHelpers, divergentNames, clonedCopies: raw.clonedCopies }
}

const manifest = readCanonicalManifest()

/** Names defined in more than one SHIPPED file, mapped to their distinct implementation count. */
function divergentNames(helpers: Helper[]): Record<string, number> {
  const byName = new Map<string, Helper[]>()
  for (const h of helpers) {
    if (!h.shipped || h.size < MIN_MEANINGFUL_BODY) continue
    const list = byName.get(h.name) ?? []
    list.push(h)
    byName.set(h.name, list)
  }
  const out: Record<string, number> = {}
  for (const [name, list] of byName) {
    if (new Set(list.map((h) => h.file)).size < 2) continue
    out[name] = new Set(list.map((h) => h.hash)).size
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Copies of a helper beyond the first, across files.
 *
 * Counted as COPIES rather than groups on purpose: a fourth copy joining an
 * existing three-copy group is exactly the event this rule exists to catch, and
 * a group count cannot see it.
 */
function clonedCopies(helpers: Helper[]): number {
  const byHash = new Map<string, Set<string>>()
  for (const h of helpers) {
    if (h.size < MIN_MEANINGFUL_BODY) continue
    const files = byHash.get(h.hash) ?? new Set()
    files.add(h.file)
    byHash.set(h.hash, files)
  }
  let copies = 0
  for (const files of byHash.values()) if (files.size > 1) copies += files.size - 1
  return copies
}

/**
 * @param helpers    top-level declarations — the shared-helper inventory the
 *                   divergence and clone floors are measured against.
 * @param everywhere the same walk including declarations nested inside other
 *                   functions. Only RESERVED reads it: a nested copy is not a
 *                   shared helper, but it is still a second `isRecord`.
 */
function check(helpers: Helper[], everywhere: Helper[], baseline: Baseline): Finding[] {
  const findings: Finding[] = []

  // RESERVED ------------------------------------------------------------------
  for (const entry of manifest.canonical) {
    const owned = new Set(entry.names)
    for (const h of everywhere) {
      if (!owned.has(h.name)) continue
      if (h.file === entry.owner) continue
      findings.push({
        rule: "reserved",
        where: `${h.file}:${h.line}`,
        detail:
          `local ${h.nested ? "nested " : ""}\`${h.name}\` shadows the canonical one.\n` +
          `        import { ${h.name} } from "${entry.module}"\n` +
          `        If you need different behaviour, give it a different name — a second \`${h.name}\`\n` +
          `        that behaves differently is the defect this rule exists to prevent.`,
      })
    }
  }

  // DIVERGENCE ----------------------------------------------------------------
  const current = divergentNames(helpers)
  for (const [name, impls] of Object.entries(current)) {
    const was = baseline.divergentNames[name]
    if (was === undefined) {
      const sites = helpers.filter((h) => h.name === name && h.shipped && h.size >= MIN_MEANINGFUL_BODY)
      findings.push({
        rule: "divergence",
        where: sites.map((s) => `${s.file}:${s.line}`).join("\n            "),
        detail:
          `\`${name}\` is now defined in ${new Set(sites.map((s) => s.file)).size} shipped files (${impls} distinct implementations).\n` +
          `        Give it one owner and import it, or name the variants for what they actually do.`,
      })
    } else if (impls > was) {
      findings.push({
        rule: "divergence",
        where: name,
        detail:
          `\`${name}\` grew from ${was} to ${impls} distinct implementations.\n` +
          `        A new spelling of an existing helper is how these names stop meaning one thing.`,
      })
    }
  }

  // TWINS ---------------------------------------------------------------------
  for (const twin of manifest.twins) {
    const contents = twin.files.map((f) => {
      const abs = path.join(REPO_ROOT, f)
      return { f, exists: fs.existsSync(abs), body: fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "" }
    })
    const missing = contents.filter((c) => !c.exists)
    if (missing.length) {
      findings.push({ rule: "twins", where: missing.map((m) => m.f).join(", "), detail: "declared twin file does not exist" })
      continue
    }
    // Comments may differ — each copy explains itself in its own context. Code may not.
    const stripped = contents.map((c) => ({
      f: c.f,
      code: c.body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\s+/g, " ").trim(),
    }))
    const first = stripped[0]!
    for (const other of stripped.slice(1)) {
      if (other.code !== first.code) {
        findings.push({
          rule: "twins",
          where: `${first.f}\n            ${other.f}`,
          detail: `declared twins have drifted.\n        Reason on record: ${twin.reason}\n        Re-sync them, or delete the twin entry and justify two implementations.`,
        })
      }
    }
  }

  return findings
}

function main() {
  const helpers = inventory()
  const truncated = helpers.filter((h) => TRUNCATED.test(h.body))
  if (truncated.length > MAX_TRUNCATED_BODIES) {
    console.error(`MEASUREMENT FAILURE: ${truncated.length} helper bodies end mid-token (max ${MAX_TRUNCATED_BODIES}).`)
    console.error("The extractor lost the end of these declarations; every rule below would compare prefixes.")
    for (const h of truncated.slice(0, 5)) console.error(`  ${h.file}:${h.line} ${h.name}`)
    process.exit(2)
  }
  if (helpers.length < MIN_PLAUSIBLE_HELPERS) {
    console.error(`MEASUREMENT FAILURE: only ${helpers.length} helpers found (expected >= ${MIN_PLAUSIBLE_HELPERS}).`)
    console.error("The walk resolved almost nothing; every rule below would pass for the wrong reason.")
    process.exit(2)
  }

  if (process.argv.includes("--baseline")) {
    const next: Baseline = {
      totalHelpers: helpers.length,
      divergentNames: divergentNames(helpers),
      clonedCopies: clonedCopies(helpers),
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`)
    const impls = Object.values(next.divergentNames).reduce((a, b) => a + b, 0)
    console.log(`recorded ${Object.keys(next.divergentNames).length} divergent names (${impls} implementations), ${next.clonedCopies} duplicated copies`)
    return
  }

  const baseline = readBaseline()
  const findings = check(helpers, inventory({ nested: true }), baseline)
  const clones = clonedCopies(helpers)
  if (clones > baseline.clonedCopies) {
    findings.push({
      rule: "clones",
      where: "repository",
      detail: `duplicated helper copies rose from ${baseline.clonedCopies} to ${clones}.\n        An existing helper was copied instead of imported; find its owner and import it.`,
    })
  }

  if (!findings.length) {
    const names = Object.keys(baseline.divergentNames).length
    console.log(`helpers ratchet passed — ${helpers.length} helpers, ${names} divergent names held, ${clones} duplicated copies held`)
    return
  }

  for (const f of findings) {
    console.error(`\n  [${f.rule}] ${f.where}\n        ${f.detail}`)
  }
  console.error(`\n${findings.length} finding(s). If a change is deliberate and reviewed, re-record with:`)
  console.error("  bun script/helpers/verify.ts --baseline")
  process.exit(1)
}

main()
