/**
 * Aggregate the per-shard capability classifications into one catalog of the
 * methods `@claxedo/helpers` would have to provide.
 *
 * The agents each saw ~110 helpers and nothing else, so two shards will spell
 * the same behaviour differently: `narrow-unknown-to-plain-object-rejecting-arrays`
 * and `narrow-value-to-plain-object-reject-arrays` are one capability with two
 * names. Grouping on the slug alone would report them as two capabilities of
 * demand 1 instead of one capability of demand 2 — which is exactly backwards
 * for a ranking whose whole purpose is to find what is demanded most. So slugs
 * are merged on their significant-token sets, and every spelling that was
 * folded in is kept as an alias so a reader can disagree with the merge.
 *
 *   bun script/helpers/catalog.ts
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isBoolean, isNonEmptyString, isRecord, isString } from "../../packages/claxedo-helpers/src/guards.ts"
import { readCorpus } from "./corpus.ts"

const ART = path.join(import.meta.dirname, "../../.artifacts/helpers")
const OUT_DIR = path.join(ART, "out")
const PKG = path.join(import.meta.dirname, "../../packages/claxedo-helpers")

type Entry = { id: number; capability: string; category: string; description: string; generic: boolean; note?: string }

/** One shard classification, or undefined when the agent's output is missing a field. */
function toEntry(raw: unknown): Entry | undefined {
  if (!isRecord(raw)) return undefined
  const { id, capability, category, description, generic, note } = raw
  if (typeof id !== "number" || !isNonEmptyString(capability) || !isString(category) || !isString(description) || !isBoolean(generic)) {
    return undefined
  }
  return { id, capability, category, description, generic, note: isString(note) ? note : undefined }
}

/** Words that carry no behaviour, so two slugs that differ only here are the same slug. */
const NOISE = new Set([
  "a", "an", "the", "to", "for", "from", "of", "into", "as", "with", "and", "or", "if", "is", "on", "in", "by",
  "value", "values", "input", "inputs", "given", "provided", "arg", "args", "unknown", "any", "data", "item",
])
/** Different spellings of one idea. Merging these is what makes token comparison work at all. */
const SYNONYM: Record<string, string> = {
  narrows: "narrow", checks: "narrow", check: "narrow", guard: "narrow", assert: "narrow", test: "narrow",
  validate: "narrow", validates: "narrow", verify: "narrow", ensure: "narrow", determine: "narrow", detect: "narrow",
  returns: "return", gets: "return", get: "return", read: "return", fetch: "return", retrieve: "return", extract: "return",
  converts: "coerce", convert: "coerce", coerces: "coerce", cast: "coerce", parses: "parse",
  formats: "format", render: "format", stringify: "format", display: "format",
  creates: "create", make: "create", build: "create", construct: "create", produce: "create", generate: "create",
  removes: "strip", remove: "strip", strips: "strip", delete: "strip", drop: "strip", filter: "strip",
  rejecting: "reject", rejects: "reject", excluding: "reject", exclude: "reject",
  allowing: "allow", allows: "allow", accepting: "allow", accepts: "allow", including: "allow",
  objects: "object", record: "object", dictionary: "object", plain: "object",
  arrays: "array", list: "array", lists: "array",
  strings: "string", str: "string", text: "string",
  numbers: "number", numeric: "number", num: "number",
  booleans: "bool", boolean: "bool", bools: "bool",
  milliseconds: "ms", millis: "ms", msec: "ms",
  optional: "nullish", nullable: "nullish", undefined: "nullish", null: "nullish",
  errors: "error", exception: "error",
  messages: "message", msg: "message",
  readable: "human", friendly: "human", pretty: "human",
  order: "sort", comparison: "compare", comparator: "compare",
  wait: "sleep", delay: "sleep", pause: "sleep",
  copy: "clone", duplicate: "clone",
  filepath: "path", filesystem: "path", dir: "path", directory: "path",
  uri: "url", href: "url", link: "url",
  identifier: "id", uuid: "id",
  concat: "join", combine: "merge",
  limit: "clamp", bound: "clamp", cap: "clamp",
  dedupe: "unique", distinct: "unique",
  one: "1", two: "2", three: "3", four: "4", six: "6", eight: "8", ten: "10",
  decimals: "decimal", places: "decimal", digits: "decimal",
}

function tokens(slug: string): Set<string> {
  const out = new Set<string>()
  for (const raw of slug.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || NOISE.has(raw)) continue
    out.add(SYNONYM[raw] ?? raw)
  }
  return out
}

/**
 * The only token a slug may add without naming a different capability.
 *
 * `narrow-string` and `narrow-string-or-undefined` are one method described at
 * two levels of precision. Every other extra token earns its place: `reject`,
 * `allow`, `map`, `empty` are the difference between helpers that disagree.
 */
const HEDGE = new Set(["nullish"])

/**
 * Whether two slugs name one capability.
 *
 * Overlap alone is too blunt at these sizes — the pair above scores 0.67 — so a
 * strict subset that adds only a hedge token also matches. The 0.8 floor is not
 * cosmetic: at 0.75 a three-token slug merges with any four-token slug it sits
 * inside, which put `narrow-array-or-object` in the array-REJECTING cluster —
 * the one distinction this catalog exists to keep visible.
 */
function sameCapability(a: Set<string>, b: Set<string>): boolean {
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  if (union === 0) return false
  if (inter / union >= 0.8) return true
  if (inter !== Math.min(a.size, b.size)) return false
  const bigger = a.size > b.size ? a : b
  const smaller = a.size > b.size ? b : a
  const extra = [...bigger].filter((t) => !smaller.has(t))
  return extra.length === 1 && HEDGE.has(extra[0]!)
}

function readEntries(): Entry[] {
  if (!fs.existsSync(OUT_DIR)) throw new Error(`no results at ${OUT_DIR}`)
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")).sort()
  const out: Entry[] = []
  const bad: string[] = []
  for (const f of files) {
    try {
      const parsed = readJsonFile(path.join(OUT_DIR, f))
      const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.entries : undefined
      const entries: unknown[] | undefined = Array.isArray(list) ? list : undefined
      if (!entries) {
        bad.push(`${f}: no entries array`)
        continue
      }
      for (const raw of entries) {
        const e = toEntry(raw)
        if (!e) {
          bad.push(`${f}: malformed entry`)
          continue
        }
        out.push(e)
      }
    } catch (err) {
      bad.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (bad.length) {
    console.error(`WARNING: ${bad.length} unreadable result(s):`)
    for (const b of bad.slice(0, 10)) console.error(`  ${b}`)
  }
  console.log(`read ${out.length} classifications from ${files.length} shard result(s)`)
  return out
}

type Capability = {
  slug: string
  aliases: string[]
  category: string
  description: string
  generic: boolean
  demand: number
  distinctImpls: number
  files: number
  packages: string[]
  movability: Record<string, number>
  sites: { name: string; at: string; loc: number }[]
  notes: string[]
}

function main() {
  const corpus = readCorpus(path.join(ART, "corpus.json"))
  const byId = new Map(corpus.map((c) => [c.id, c]))
  const entries = readEntries()

  const classified = new Set(entries.map((e) => e.id))
  if (classified.size < corpus.length) {
    console.error(`WARNING: ${corpus.length - classified.size} of ${corpus.length} helpers were never classified`)
  }

  // Exact slug first, then merge slugs whose tokens agree.
  //
  // Deliberately NOT partitioned by category: `category` is a label each agent
  // picked on its own, and the same trim-to-undefined helper was filed under
  // `string` by one shard and `guard-narrowing` by another. Partitioning on it
  // splits one capability of demand 48 into two of 32 and 16. A cluster takes
  // the category its members most often chose instead.
  const exact = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = e.capability.toLowerCase()
    const list = exact.get(key) ?? []
    list.push(e)
    exact.set(key, list)
  }

  type Cluster = { slugs: Map<string, number>; tokens: Set<string>; entries: Entry[] }
  const clusters: Cluster[] = []
  // Bucketed by token, so a slug is compared against the clusters that share a
  // word with it rather than against all ten thousand of them.
  const byToken = new Map<string, Cluster[]>()
  let merged = 0
  // Largest groups first, so the dominant spelling becomes the cluster's name.
  const ordered = [...exact.values()].sort((a, b) => b.length - a.length)
  for (const group of ordered) {
    const slug = group[0]!.capability
    const tk = tokens(slug)
    const seen = new Set<Cluster>()
    let joined: Cluster | undefined
    for (const t of tk) {
      for (const c of byToken.get(t) ?? []) {
        if (seen.has(c)) continue
        seen.add(c)
        if (sameCapability(tk, c.tokens)) {
          joined = c
          break
        }
      }
      if (joined) break
    }
    if (joined) {
      joined.entries.push(...group)
      joined.slugs.set(slug, (joined.slugs.get(slug) ?? 0) + group.length)
      merged++
    } else {
      const created: Cluster = { slugs: new Map([[slug, group.length]]), tokens: tk, entries: [...group] }
      clusters.push(created)
      for (const t of tk) byToken.set(t, [...(byToken.get(t) ?? []), created])
    }
  }

  const caps: Capability[] = []
  {
    for (const c of clusters) {
      const rows = c.entries.flatMap((e) => {
        const h = byId.get(e.id)
        return h ? [{ e, h }] : []
      })
      if (!rows.length) continue
      const slugs = [...c.slugs.entries()].sort((a, b) => b[1] - a[1])
      // The description most callers would recognise: from the dominant
      // spelling, longest as the tiebreak.
      const desc = c.entries
        .slice()
        .sort(
          (a, b) =>
            (c.slugs.get(b.capability) ?? 0) - (c.slugs.get(a.capability) ?? 0) ||
            b.description.length - a.description.length,
        )[0]!.description
      const move: Record<string, number> = {}
      for (const r of rows) move[r.h.movability] = (move[r.h.movability] ?? 0) + 1
      const votes = new Map<string, number>()
      for (const e of c.entries) votes.set(e.category, (votes.get(e.category) ?? 0) + 1)
      const category = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
      caps.push({
        slug: slugs[0]![0],
        aliases: slugs.slice(1).map(([s]) => s),
        category,
        description: desc,
        generic: c.entries.filter((e) => e.generic).length * 2 >= c.entries.length,
        demand: rows.length,
        distinctImpls: new Set(rows.map((r) => r.h.hash)).size,
        files: new Set(rows.map((r) => r.h.file)).size,
        packages: [...new Set(rows.map((r) => r.h.pkg))].sort(),
        movability: move,
        sites: rows
          .slice()
          .sort((a, b) => a.h.loc - b.h.loc)
          .slice(0, 8)
          .map((r) => ({ name: r.h.name, at: `${r.h.file}:${r.h.line}`, loc: r.h.loc })),
        notes: c.entries.map((e) => e.note).filter((n): n is string => !!n && n.trim().length > 0).slice(0, 6),
      })
    }
  }
  caps.sort((a, b) => b.demand - a.demand || a.slug.localeCompare(b.slug))

  const generic = caps.filter((c) => c.generic)
  fs.writeFileSync(path.join(PKG, "catalog.json"), `${JSON.stringify({ capabilities: caps }, null, 2)}\n`)

  const byCat = new Map<string, Capability[]>()
  for (const c of generic) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c])

  const md: string[] = []
  md.push("# Helper capability catalog")
  md.push("")
  md.push("Generated by `bun script/helpers/catalog.ts` from a full read of every top-level")
  md.push("helper in `packages/`. It answers one question: **what methods would a shared")
  md.push("helpers package have to provide?** Whether each is written here or taken from a")
  md.push("dependency is a separate decision, and replacing call sites is a separate job")
  md.push("after that.")
  md.push("")
  md.push("`demand` counts existing definitions; `impls` counts how many of them are")
  md.push("genuinely different code. A capability with demand 9 and impls 9 is nine people")
  md.push("solving one problem nine ways — the strongest case for a single owner, and the")
  md.push("most dangerous to consolidate blind, because some of the differences are")
  md.push("deliberate.")
  md.push("")
  md.push(`${caps.length} capabilities across ${entries.length} helpers; ${generic.length} are general-purpose.`)
  md.push("")
  for (const [cat, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const defs = list.reduce((a, c) => a + c.demand, 0)
    md.push(`## ${cat} — ${list.length} capabilities, ${defs} definitions`)
    md.push("")
    md.push("| demand | impls | pkgs | capability | what it does |")
    md.push("| ---: | ---: | ---: | --- | --- |")
    for (const c of list.slice().sort((a, b) => b.demand - a.demand)) {
      md.push(
        `| ${c.demand} | ${c.distinctImpls} | ${c.packages.length} | \`${c.slug}\` | ${c.description.replace(/\|/g, "\\|")} |`,
      )
    }
    md.push("")
  }
  fs.writeFileSync(path.join(PKG, "CATALOG.md"), `${md.join("\n")}\n`)

  console.log(`\n${caps.length} capabilities (${generic.length} general-purpose, ${caps.length - generic.length} app-specific)`)
  console.log(`${merged} slug spellings folded into an existing capability`)
  console.log("\ntop demand:")
  for (const c of generic.slice(0, 20)) {
    console.log(`  ${String(c.demand).padStart(4)} defs / ${String(c.distinctImpls).padStart(3)} impls  ${c.slug}`)
  }
  console.log(`\nwrote packages/claxedo-helpers/catalog.json and CATALOG.md`)
}

main()
