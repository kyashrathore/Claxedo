import { build } from "vite"
import { readFileSync } from "node:fs"

const ROOT = "/Users/yashvardhansingh/test/opencode/packages/claxedo-app"
const CONFIG = ROOT + "/vite.cloud.config.ts"
const REPO_ROOT = "/Users/yashvardhansingh/test/opencode"

// Packages we explicitly DON'T care about (genuine first-paint / framework deps).
const IGNORE_PKGS = new Set([
  "solid-js",
  "@solidjs/router",
  "@solidjs/meta",
  "@kobalte/core",
  "@kobalte/utils",
  "@tanstack/query-core",
  "@tanstack/solid-query",
  "@tanstack/solid-store",
  "@tanstack/store",
  "@internationalized/date",
  "seroval",
  "seroval-plugins",
])

function abbr(id) {
  if (!id) return id
  let s = id
  // strip null-byte virtual prefix
  if (s.startsWith("\0")) s = s.slice(1)
  // strip query/commonjs suffixes for readability but keep marker
  const repoRel = s.startsWith(REPO_ROOT) ? s.slice(REPO_ROOT.length + 1) : s
  return repoRel
}

function firstParty(id) {
  return id && !id.includes("node_modules") && !id.startsWith("\0")
}

// Extract a node_modules package name from a module id, or null.
function pkgOf(id) {
  if (!id) return null
  const idx = id.lastIndexOf("node_modules/")
  if (idx === -1) return null
  let rest = id.slice(idx + "node_modules/".length)
  // strip leading null-byte virtuals like \0... unlikely after node_modules
  const parts = rest.split("/")
  if (parts[0].startsWith("@")) {
    return parts[0] + "/" + (parts[1] || "")
  }
  return parts[0]
}

// Detect whether a module id is a barrel / re-export index that fans out via export *
// or re-exports from a heavy sibling. Best-effort static read of the file.
const barrelCache = new Map()
function looksLikeBarrel(id) {
  if (barrelCache.has(id)) return barrelCache.get(id)
  let verdict = false
  let detail = ""
  try {
    // strip virtual prefixes / query strings to get a real path
    let path = id.startsWith("\0") ? id.slice(1) : id
    const q = path.indexOf("?")
    if (q !== -1) path = path.slice(0, q)
    const base = path.split("/").pop() || ""
    const isIndexish = /^index\.[tj]sx?$/.test(base) || base === "index.ts" || base === "index.js"
    const src = readFileSync(path, "utf8")
    const reExportStar = /export\s+\*\s+from/.test(src)
    const reExportNamed = /export\s+\{[^}]*\}\s+from/.test(src)
    if (reExportStar) {
      verdict = true
      detail = "export *"
    } else if (isIndexish && reExportNamed) {
      verdict = true
      detail = "index re-export { }"
    } else if (reExportNamed && (src.match(/export\s+\{[^}]*\}\s+from/g) || []).length >= 3) {
      verdict = true
      detail = "multi re-export { }"
    }
  } catch {
    // not readable (virtual) — ignore
  }
  const res = { verdict, detail }
  barrelCache.set(id, res)
  return res
}

const BARE_BARRELS = ["@opencode-ai/app", "@opencode-ai/ui"]

await build({
  configFile: CONFIG,
  root: ROOT,
  logLevel: "error",
  build: { write: false, sourcemap: false },
  plugins: [
    {
      name: "probe-eager",
      buildEnd() {
        const getInfo = (id) => this.getModuleInfo(id)
        const allIds = [...this.getModuleIds()]

        const entries = allIds.filter((id) => {
          const info = getInfo(id)
          return info && info.isEntry
        })

        // BFS over STATIC importedIds only, from all entry modules.
        // Record parent for shortest-chain reconstruction.
        const visited = new Set()
        const parent = new Map()
        const queue = []
        for (const e of entries) {
          visited.add(e)
          parent.set(e, null)
          queue.push(e)
        }
        while (queue.length) {
          const cur = queue.shift()
          const info = getInfo(cur)
          if (!info) continue
          for (const next of info.importedIds || []) {
            if (!visited.has(next)) {
              visited.add(next)
              parent.set(next, cur)
              queue.push(next)
            }
          }
        }

        // visited = the statically-eager reachable set (entry chunk + everything
        // pulled in via static imports). Group node_modules modules by package.
        const pkgs = new Map() // pkgName -> { modules: Set, firstHit: id (shortest-depth) }
        const depthCache = new Map()
        function depthOf(id) {
          if (depthCache.has(id)) return depthCache.get(id)
          let d = 0
          let n = id
          while (parent.get(n) != null) {
            n = parent.get(n)
            d++
          }
          depthCache.set(id, d)
          return d
        }

        for (const id of visited) {
          const pkg = pkgOf(id)
          if (!pkg) continue
          let rec = pkgs.get(pkg)
          if (!rec) {
            rec = { modules: new Set(), firstHit: id }
            pkgs.set(pkg, rec)
          }
          rec.modules.add(id)
          if (depthOf(id) < depthOf(rec.firstHit)) rec.firstHit = id
        }

        function chainTo(id) {
          const chain = []
          let n = id
          while (n != null) {
            chain.unshift(n)
            n = parent.get(n)
          }
          return chain
        }

        // Identify, for a chain, the first edge that crosses out of first-party
        // and whether that crossing module (the importer) is a barrel, or whether
        // the entry into node_modules is one of the bare barrels.
        function analyzeChain(chain) {
          const notes = []
          for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i]
            const b = chain[i + 1]
            const aFirst = firstParty(a)
            const bPkg = pkgOf(b)
            // first crossing first-party -> node_modules
            if (aFirst && bPkg) {
              const bare = BARE_BARRELS.find((bb) => b.includes("node_modules/" + bb + "/"))
              if (bare) notes.push("BARE-BARREL entry via " + bare)
              const barA = looksLikeBarrel(a)
              if (barA.verdict) notes.push("importer is BARREL (" + barA.detail + "): " + abbr(a))
              const barB = looksLikeBarrel(b)
              if (barB.verdict) notes.push("target entry is BARREL (" + barB.detail + "): " + abbr(b))
              break
            }
          }
          // also flag any barrel anywhere in the first-party prefix of chain
          return notes
        }

        const ranked = [...pkgs.entries()]
          .map(([name, rec]) => ({ name, count: rec.modules.size, firstHit: rec.firstHit }))
          .filter((p) => !IGNORE_PKGS.has(p.name))
          .sort((a, b) => b.count - a.count)

        console.log("=== ENTRIES ===")
        for (const e of entries) console.log("  " + abbr(e))
        console.log("=== TOTAL MODULES IN GRAPH:", allIds.length, "| STATICALLY-EAGER:", visited.size, "===")
        console.log("")
        console.log("=== EAGER node_modules PACKAGES (excluding framework/i18n), by #eager modules ===")
        console.log("")

        for (const p of ranked) {
          const chain = chainTo(p.firstHit)
          const notes = analyzeChain(chain)
          console.log("──────────────────────────────────────────────────────────────")
          console.log("PKG: " + p.name + "   [" + p.count + " eager module(s)]")
          if (notes.length) {
            for (const n of notes) console.log("  ⚑ CHEAP-WIN SIGNAL: " + n)
          }
          console.log("  shortest static chain (entry -> pkg), len " + chain.length + ":")
          for (const id of chain) {
            const marker = firstParty(id) ? "    " : "  * "
            console.log(marker + abbr(id))
          }
          console.log("")
        }
      },
    },
  ],
})

process.exit(0)
