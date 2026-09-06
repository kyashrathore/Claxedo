/**
 * `worklist` — turns one Phase-1 cluster into a slice a migration lane can act on.
 *
 * The cluster catalog answers "which helpers are the same capability". Running
 * cluster 000 proved that is not enough to change code with. Five things the
 * catalog does not say, each of which cost that lane a rediscovery:
 *
 *   IMPORTERS   A cluster records definition sites. When the local copy is
 *               `export`ed, deleting it breaks every importer, and none of them
 *               are in the cluster. `sdk-runtime-values.ts` exported `record`
 *               through a barrel to 11 further files; five took it through a
 *               multi-line import, which a line-oriented grep cannot see.
 *
 *   DELEGATION  A body that just calls another local helper was clustered by
 *               the wrapper's shape, not the callee's. `bootstrap.ts` landed in
 *               the array-REJECTING cluster while the guard it delegates to
 *               accepts arrays, so the lane would have changed behaviour and
 *               the array-ALLOWING cluster undercounted its own demand.
 *
 *   RETURN      `asRecord` and `asRecordOrEmpty` are one predicate with two
 *               miss values. The slug tokens that name the miss value —
 *               `-or-undefined`, `-with-empty-fallback` — pushed the same
 *               capability into clusters 000, 108 and 109, so a lane that took
 *               only 000 left the other two behind and would have swapped `{}`
 *               for `undefined` at every site it did take.
 *
 *   MANIFESTS   Five packages assert their dependency list as a literal array.
 *               Wiring a package edge reddens them before a single source line
 *               changes.
 *
 *   DONE        A migrated site often keeps a wrapper, because the shared
 *               predicate cannot carry the caller's error policy. Matching the
 *               cluster on name and line alone reported all five of cluster
 *               000's finished wrappers as outstanding, printing the snapshot
 *               body rather than the live one — so the lane's obvious next move
 *               was to delete an auth path's `invalidCredentials()`.
 *
 * Sibling clusters are found from evidence, not by loosening the slug
 * threshold: two clusters are siblings when they share a body hash (the same
 * code filed under two slugs) or share definition names. The threshold is left
 * alone deliberately — relaxing it is what merged array-allowing guards into
 * array-rejecting ones the first time.
 *
 *   bun script/helpers/worklist.ts 001
 *   bun script/helpers/worklist.ts 001 --json
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { readJsonFile } from "../../packages/claxedo-helpers/src/fs.ts"
import { isBoolean, isNonEmptyString, isRecord, isString } from "../../packages/claxedo-helpers/src/guards.ts"
import { readCorpus } from "./corpus.ts"
import { inventory, REPO_ROOT, sourceFiles, type Helper } from "./extract.ts"
import { readCanonicalManifest } from "./manifest.ts"

const ARTIFACTS = path.join(REPO_ROOT, ".artifacts/helpers")
const CLUSTERS = path.join(ARTIFACTS, "clusters")

type Definition = {
  name: string
  at: string
  pkg: string
  exported?: boolean
  body: string
}
type Cluster = {
  slug: string
  description?: string
  demand?: number
  definitions: Definition[]
}

/** The fields the worklist reads; a cluster file carries more, which pass through untouched. */
function toCluster(raw: unknown, file: string): Cluster {
  const definitions: unknown[] | undefined = isRecord(raw) && Array.isArray(raw.definitions) ? raw.definitions : undefined
  if (!isRecord(raw) || !isString(raw.slug) || !definitions) throw new Error(`${file}: not a cluster`)
  return {
    slug: raw.slug,
    description: isString(raw.description) ? raw.description : undefined,
    demand: typeof raw.demand === "number" ? raw.demand : undefined,
    definitions: definitions.map((d) => {
      if (!isRecord(d) || !isString(d.name) || !isString(d.at) || !isString(d.pkg) || !isString(d.body)) {
        throw new Error(`${file}: definition is not a helper site`)
      }
      return { name: d.name, at: d.at, pkg: d.pkg, body: d.body, exported: isBoolean(d.exported) ? d.exported : undefined }
    }),
  }
}

// -- return shape -------------------------------------------------------------

/**
 * What the function yields when the input does NOT match — the axis the slug
 * tokens encode and the cluster does not. Two definitions with the same
 * predicate and different miss values need different canonical names, so a
 * lane that cannot see this swaps one for the other silently.
 */
const MISS = [
  ["throw", /\bthrow\b/],
  ["{}", /(?:return|\?\?|\|\||:)\s*\{\s*\}/],
  ["[]", /(?:return|\?\?|\|\||:)\s*\[\s*\]/],
  ['""', /(?:return|\?\?|\|\||:)\s*(?:""|''|``)/],
  ["null", /(?:return|\?\?|\|\||:)\s*null\b/],
  ["undefined", /(?:return|\?\?|\|\||:)\s*undefined\b/],
  ["0", /(?:return|\?\?|\|\|)\s*0\b/],
  ["false", /(?:return|\?\?|\|\||:)\s*false\b/],
] as const

function returnShape(body: string): string {
  const found = MISS.filter(([, re]) => re.test(body)).map(([tag]) => tag)
  if (!found.length) return /\breturn\b/.test(body) ? "value-only" : "implicit-undefined"
  return found.join("+")
}

// -- module resolution --------------------------------------------------------

function packageDirs(): Map<string, string> {
  const out = new Map<string, string>()
  const base = path.join(REPO_ROOT, "packages")
  for (const dir of fs.readdirSync(base)) {
    const manifest = path.join(base, dir, "package.json")
    if (!fs.existsSync(manifest)) continue
    try {
      const parsed = readJsonFile(manifest)
      const name = isRecord(parsed) ? parsed.name : undefined
      if (isNonEmptyString(name)) out.set(name, path.join("packages", dir))
    } catch {
      // A manifest that will not parse cannot own a specifier; the walk continues.
    }
  }
  return out
}

const PKG_DIRS = packageDirs()
const EXT = [".ts", ".tsx", ".cf.ts", "/index.ts", "/index.tsx", ".js"]

/** Repo-relative file a specifier names, or undefined when it leaves the workspace. */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  let guess: string
  if (spec.startsWith(".")) {
    guess = path.normalize(path.join(path.dirname(fromFile), spec))
  } else {
    const owner = [...PKG_DIRS.keys()].find((n) => spec === n || spec.startsWith(`${n}/`))
    if (!owner) return undefined
    const sub = spec.slice(owner.length).replace(/^\//, "")
    guess = path.join(PKG_DIRS.get(owner)!, "src", sub || "index")
  }
  guess = guess.replace(/\.js$/, "")
  for (const ext of ["", ...EXT]) {
    if (fs.existsSync(path.join(REPO_ROOT, guess + ext))) {
      const hit = guess + ext
      if (fs.statSync(path.join(REPO_ROOT, hit)).isFile()) return hit
    }
  }
  return undefined
}

type Binding = { file: string; spec: string; target?: string; names: string[]; star: boolean; reExport: boolean }

/**
 * Every `import`/`export … from` in the file, with its brace list flattened.
 *
 * Deliberately not line-oriented: five of the eleven consumers the cluster-000
 * lane missed spread the brace list across several lines.
 */
const BINDING = /\b(import|export)\s+(?:type\s+)?(?:(\*)(?:\s+as\s+[\w$]+)?|\{([\s\S]*?)\})\s*from\s*["']([^"']+)["']/g

function bindingsIn(file: string, text: string): Binding[] {
  const out: Binding[] = []
  for (const m of text.matchAll(BINDING)) {
    const names = (m[3] ?? "")
      .split(",")
      .map((piece) => piece.replace(/\btype\b/, "").trim())
      .map((piece) => piece.split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean)
    out.push({ file, spec: m[4]!, target: resolveSpecifier(file, m[4]!), names, star: !!m[2], reExport: m[1] === "export" })
  }
  return out
}

// -- passes -------------------------------------------------------------------

function consumersOf(defFile: string, name: string, all: Binding[]): { direct: string[]; viaBarrel: { barrel: string; files: string[] }[] } {
  const takes = (b: Binding) => b.star || b.names.includes(name)
  const direct = all.filter((b) => b.target === defFile && !b.reExport && takes(b)).map((b) => b.file)
  const barrels = [...new Set(all.filter((b) => b.target === defFile && b.reExport && takes(b)).map((b) => b.file))]
  const viaBarrel = barrels.map((barrel) => ({
    barrel,
    files: [...new Set(all.filter((b) => b.target === barrel && !b.reExport && takes(b)).map((b) => b.file))].sort(),
  }))
  return { direct: [...new Set(direct)].sort(), viaBarrel: viaBarrel.filter((v) => v.files.length) }
}

/**
 * The local helper this body defers its decision to.
 *
 * One level only. The point is to show the lane the code that actually decides,
 * not to build a call graph: a wrapper around a wrapper is rare, and reporting
 * the first hop is enough to stop the wrapper's own shape from standing in for
 * a predicate it does not implement.
 */
function delegateOf(def: Helper, inFile: Helper[]): Helper | undefined {
  const others = new Map(inFile.filter((h) => h.name !== def.name).map((h) => [h.name, h]))
  for (const m of def.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const hit = others.get(m[1]!)
    if (hit) return hit
  }
  return undefined
}

/**
 * A definition that now calls a canonical helper is migrated, however its own
 * body reads: the wrappers left behind are deliberate, because the shared
 * predicate cannot carry a caller's error policy (`DocumentToolError`,
 * `invalidCredentials()`, an `invariant`). Without this, a finished cluster
 * reports those wrappers as outstanding and the next lane redoes the work.
 */
function migratedTo(def: Helper, fileText: string): string | undefined {
  for (const entry of readCanonicalManifest().canonical) {
    if (!new RegExp(`from\\s*"${entry.module}"`).test(fileText)) continue
    for (const name of entry.names) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(def.body)) return `${name} from ${entry.module}`
    }
  }
  return undefined
}

const TEST_FILE = /\.(test|vitest|spec)\.tsx?$/
const DEP_ASSERTION = /\bdependencies\b[\s\S]{0,120}?(?:\btoEqual\(\s*\[|\btoStrictEqual\(\s*\[)|Object\.keys\([^)]*\bdependencies\b[\s\S]{0,80}?\bsort\(\)/

/** Tests that pin a package's dependency list as a literal array. */
function dependencyAssertions(pkgs: Set<string>): string[] {
  const out: string[] = []
  for (const { pkg, abs } of sourceFiles({ tests: true })) {
    if (!pkgs.has(pkg) || !TEST_FILE.test(path.basename(abs))) continue
    if (DEP_ASSERTION.test(fs.readFileSync(abs, "utf8"))) out.push(path.relative(REPO_ROOT, abs))
  }
  return out.sort()
}

// -- main ---------------------------------------------------------------------

function loadClusters(): { id: string; cluster: Cluster }[] {
  return fs
    .readdirSync(CLUSTERS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ""), cluster: toCluster(readJsonFile(path.join(CLUSTERS, f)), f) }))
}

function main() {
  const id = process.argv[2]
  if (!id) {
    console.error("usage: bun script/helpers/worklist.ts <cluster-id> [--json]")
    process.exit(2)
  }
  const clusters = loadClusters()
  const self = clusters.find((c) => c.id === id.padStart(3, "0"))
  if (!self) {
    console.error(`no cluster ${id} under ${path.relative(REPO_ROOT, CLUSTERS)}`)
    process.exit(2)
  }

  const corpus = readCorpus(path.join(ARTIFACTS, "corpus.json"))
  const hashAt = new Map(corpus.map((h) => [`${h.file}:${h.line}`, h.hash]))

  // Siblings: same code under a different slug, or the same names. Evidence,
  // not a looser slug threshold.
  const ownHashes = new Set(self.cluster.definitions.flatMap((d) => hashAt.get(d.at) ?? []))
  const ownNames = new Set(self.cluster.definitions.map((d) => d.name))
  const siblings = clusters
    .filter((c) => c.id !== self.id)
    .map((c) => {
      const hashes = [...new Set(c.cluster.definitions.flatMap((d) => hashAt.get(d.at) ?? []).filter((h) => ownHashes.has(h)))]
      const names = [...new Set(c.cluster.definitions.map((d) => d.name).filter((n) => ownNames.has(n)))]
      return { id: c.id, slug: c.cluster.slug, demand: c.cluster.demand ?? c.cluster.definitions.length, sharedHashes: hashes.length, sharedNames: names }
    })
    .filter((s) => s.sharedHashes > 0 || s.sharedNames.length > 0)
    .sort((a, b) => b.sharedHashes - a.sharedHashes || b.sharedNames.length - a.sharedNames.length)

  // Live tree. The cluster is a frozen Phase-1 read; consumers, delegation and
  // nested shadows are properties of the code as it stands now.
  const live = inventory({ nested: true })
  const liveByFile = new Map<string, Helper[]>()
  for (const h of live) liveByFile.set(h.file, [...(liveByFile.get(h.file) ?? []), h])

  // `tests: true`: a test file importing a helper is a consumer that breaks on
  // deletion, and typecheck cannot report it — the typecheck tsconfigs exclude
  // `*.test.ts`, so the failure only surfaces when the runner loads the module.
  const bindings: Binding[] = []
  for (const { abs } of sourceFiles({ tests: true })) {
    const rel = path.relative(REPO_ROOT, abs)
    bindings.push(...bindingsIn(rel, fs.readFileSync(abs, "utf8")))
  }

  const entries = self.cluster.definitions.map((d) => {
    const [file, lineText] = [d.at.slice(0, d.at.lastIndexOf(":")), d.at.slice(d.at.lastIndexOf(":") + 1)]
    const line = Number(lineText)
    const inFile = liveByFile.get(file) ?? []
    const def = inFile.find((h) => h.name === d.name && Math.abs(h.line - line) <= 3)
    const delegate = def ? delegateOf(def, inFile) : undefined
    const migrated = def ? migratedTo(def, fs.readFileSync(path.join(REPO_ROOT, file), "utf8")) : undefined
    return {
      at: d.at,
      name: d.name,
      pkg: d.pkg,
      exported: def?.exported ?? d.exported ?? false,
      stillPresent: !!def && !migrated,
      migratedTo: migrated,
      returnShape: returnShape(def?.body ?? d.body),
      delegatesTo: delegate ? { name: delegate.name, at: `${delegate.file}:${delegate.line}`, returnShape: returnShape(delegate.body), body: delegate.body } : undefined,
      consumers: def?.exported ? consumersOf(file, d.name, bindings) : undefined,
      body: def?.body ?? d.body,
    }
  })

  const pkgs = new Set(self.cluster.definitions.map((d) => d.at.split("/")[1]!).filter(Boolean))
  if (!pkgs.size) throw new Error("no packages resolved from definition paths — the cluster shape changed")
  const nestedShadows = live
    .filter((h) => h.nested && ownNames.has(h.name))
    .map((h) => ({ at: `${h.file}:${h.line}`, name: h.name, returnShape: returnShape(h.body) }))

  const report = {
    id: self.id,
    slug: self.cluster.slug,
    description: self.cluster.description,
    demand: self.cluster.demand,
    stillPresent: entries.filter((e) => e.stillPresent).length,
    returnShapes: entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.returnShape]: (acc[e.returnShape] ?? 0) + 1 }), {}),
    siblings,
    nestedShadows,
    dependencyAssertions: dependencyAssertions(pkgs),
    entries,
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const L = console.log
  L(`cluster ${report.id} — ${report.slug}`)
  L(`  ${report.description ?? ""}`)
  L(`  demand ${report.demand}, ${report.stillPresent} of ${entries.length} definitions still on disk\n`)

  L("RETURN SHAPES — one canonical name per shape, not one per cluster")
  for (const [shape, n] of Object.entries(report.returnShapes).sort((a, b) => b[1] - a[1])) L(`  ${String(n).padStart(3)}  ${shape}`)

  if (siblings.length) {
    L("\nSIBLING CLUSTERS — take these together or leave the name divergent")
    for (const s of siblings.slice(0, 12)) {
      const why = [s.sharedHashes ? `${s.sharedHashes} identical bodies` : "", s.sharedNames.length ? `names ${s.sharedNames.join(", ")}` : ""].filter(Boolean).join("; ")
      L(`  ${s.id}  demand ${String(s.demand).padStart(3)}  ${s.slug}\n        ${why}`)
    }
  }

  const exported = entries.filter((e) => e.consumers && (e.consumers.direct.length || e.consumers.viaBarrel.length))
  if (exported.length) {
    L("\nEXPORTED — deleting these breaks importers the cluster does not list")
    for (const e of exported) {
      L(`  ${e.at} ${e.name}`)
      for (const f of e.consumers!.direct) L(`      imports  ${f}`)
      for (const b of e.consumers!.viaBarrel) {
        L(`      barrel   ${b.barrel}`)
        for (const f of b.files) L(`         via     ${f}`)
      }
    }
  }

  const delegating = entries.filter((e) => e.delegatesTo)
  if (delegating.length) {
    L("\nDELEGATING — clustered by the wrapper; the callee is what decides")
    for (const e of delegating) L(`  ${e.at} ${e.name} -> ${e.delegatesTo!.name} at ${e.delegatesTo!.at} (miss: ${e.delegatesTo!.returnShape})`)
  }

  if (nestedShadows.length) {
    L("\nNESTED — same name declared inside another function, invisible to the cluster")
    for (const n of nestedShadows) L(`  ${n.at} ${n.name} (miss: ${n.returnShape})`)
  }

  if (report.dependencyAssertions.length) {
    L("\nEXACT DEPENDENCY LISTS — red on manifest wiring, before any source edit")
    for (const f of report.dependencyAssertions) L(`  ${f}`)
  }
}

main()
