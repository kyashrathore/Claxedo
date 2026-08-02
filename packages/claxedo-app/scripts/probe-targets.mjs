import { build } from "vite"

const ROOT = "/Users/yashvardhansingh/test/opencode/packages/claxedo-app"
const CONFIG = ROOT + "/vite.cloud.config.ts"

// targets passed as argv, e.g. node probe-targets.mjs zod @tanstack/ai motion-dom
const TARGETS = process.argv.slice(2)
if (!TARGETS.length) {
  console.error("usage: node probe-targets.mjs <substr> [<substr> ...]")
  process.exit(1)
}

function matchTarget(id, t) {
  // match npm package boundary node_modules/<t>/ or node_modules/<t>@
  return id.includes("node_modules/" + t + "/") || id.includes("/" + t + "/") && id.includes("node_modules")
    ? id.includes(t)
    : id.includes(t)
}

await build({
  configFile: CONFIG,
  root: ROOT,
  logLevel: "error",
  build: { write: false, sourcemap: false },
  plugins: [
    {
      name: "probe-targets",
      buildEnd() {
        const getInfo = (id) => this.getModuleInfo(id)
        const allIds = [...this.getModuleIds()]
        const entries = allIds.filter((id) => getInfo(id)?.isEntry)
        const firstParty = (id) => !id.includes("node_modules") && !id.startsWith("\0")
        const short = (id) => id.replace(ROOT + "/", "").replace(/^.*?node_modules\/\.bun\//, ".bun/").replace(/^.*?node_modules\//, "nm/")

        for (const TARGET of TARGETS) {
          const isHit = (id) => id.includes("node_modules") && id.includes(TARGET)
          // BFS over STATIC importedIds only
          const visited = new Set()
          const parent = new Map()
          const queue = []
          for (const e of entries) { visited.add(e); parent.set(e, null); queue.push(e) }
          let hit = null
          while (queue.length) {
            const cur = queue.shift()
            if (isHit(cur)) { hit = cur; break }
            const info = getInfo(cur)
            if (!info) continue
            for (const next of info.importedIds || []) {
              if (!visited.has(next)) { visited.add(next); parent.set(next, cur); queue.push(next) }
            }
          }

          console.log("\n########## TARGET:", TARGET, "##########")
          if (!hit) {
            // dynamic reachability check
            const dv = new Set(); const dq = []
            for (const e of entries) { dv.add(e); dq.push(e) }
            let dynHit = null
            while (dq.length) {
              const cur = dq.shift()
              if (isHit(cur)) { dynHit = cur; break }
              const info = getInfo(cur); if (!info) continue
              for (const next of [...(info.importedIds || []), ...(info.dynamicallyImportedIds || [])]) {
                if (!dv.has(next)) { dv.add(next); dq.push(next) }
              }
            }
            console.log("  NO STATIC PATH. dynamic-reachable:", !!dynHit)
            continue
          }
          const chain = []
          let n = hit
          while (n != null) { chain.unshift(n); n = parent.get(n) }
          console.log("  SHORTEST STATIC CHAIN (len " + chain.length + "):")
          for (const id of chain) console.log("    " + (firstParty(id) ? "[fp] " : "     ") + short(id))
          // last first-party edge crossing into target
          for (let i = chain.length - 1; i >= 0; i--) {
            if (firstParty(chain[i])) {
              console.log("  >>> CUT EDGE: " + short(chain[i]))
              console.log("            imports -> " + short(chain[i + 1]))
              break
            }
          }
        }
      },
    },
  ],
})
process.exit(0)
