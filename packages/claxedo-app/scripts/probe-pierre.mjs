import { build } from "vite"

const ROOT = "/Users/yashvardhansingh/test/opencode/packages/claxedo-app"
const CONFIG = ROOT + "/vite.cloud.config.ts"
const TARGET = "@pierre/diffs"

await build({
  configFile: CONFIG,
  root: ROOT,
  logLevel: "error",
  build: { write: false, sourcemap: false },
  plugins: [
    {
      name: "probe",
      buildEnd() {
        const getInfo = (id) => this.getModuleInfo(id)
        const allIds = [...this.getModuleIds()]

        const entries = allIds.filter((id) => {
          const info = getInfo(id)
          return info && info.isEntry
        })

        const isPierre = (id) => id.includes(TARGET)
        const firstParty = (id) => !id.includes("node_modules") && !id.startsWith("\0")

        // BFS over STATIC importedIds only
        const visited = new Set()
        const parent = new Map()
        const queue = []
        for (const e of entries) {
          visited.add(e)
          parent.set(e, null)
          queue.push(e)
        }

        let hit = null
        while (queue.length) {
          const cur = queue.shift()
          if (isPierre(cur)) {
            hit = cur
            break
          }
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

        console.log("=== ENTRIES ===")
        for (const e of entries) console.log("  ENTRY:", e)
        console.log("=== TOTAL MODULES:", allIds.length, "===")

        if (hit) {
          const chain = []
          let n = hit
          while (n != null) {
            chain.unshift(n)
            n = parent.get(n)
          }
          console.log("=== STATIC PATH TO PIERRE (len " + chain.length + ") ===")
          for (const id of chain) console.log("  ", id)

          // Find the first first-party module in the chain that imports the next pierre-ward module
          console.log("=== FIRST-PARTY EDGE(S) ===")
          for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i]
            const b = chain[i + 1]
            if (firstParty(a)) {
              console.log("  IMPORTER (first-party):", a)
              console.log("    -> imports:", b)
            }
          }
          // Specifically the last first-party module before crossing into node_modules/pierre territory
          for (let i = chain.length - 1; i >= 0; i--) {
            if (firstParty(chain[i])) {
              console.log("=== LAST FIRST-PARTY IN CHAIN ===")
              console.log("  ", chain[i], "-> imports ->", chain[i + 1])
              break
            }
          }
        } else {
          console.log("=== NO STATIC PATH ===")
          // Check dynamic reachability
          const dynVisited = new Set()
          const dq = []
          for (const e of entries) {
            dynVisited.add(e)
            dq.push(e)
          }
          let dynHit = null
          while (dq.length) {
            const cur = dq.shift()
            if (isPierre(cur)) {
              dynHit = cur
              break
            }
            const info = getInfo(cur)
            if (!info) continue
            for (const next of [...(info.importedIds || []), ...(info.dynamicallyImportedIds || [])]) {
              if (!dynVisited.has(next)) {
                dynVisited.add(next)
                dq.push(next)
              }
            }
          }
          console.log("Pierre reachable via dynamic+static graph:", !!dynHit, dynHit || "")
        }

        // Also: list ALL pierre modules and WHO statically imports them (importers)
        console.log("=== ALL PIERRE MODULES + STATIC IMPORTERS ===")
        for (const id of allIds) {
          if (!isPierre(id)) continue
          const info = getInfo(id)
          const staticImporters = (info.importers || []).filter((imp) => {
            const ii = getInfo(imp)
            return ii && (ii.importedIds || []).includes(id)
          })
          if (staticImporters.length) {
            console.log("  PIERRE:", id)
            for (const imp of staticImporters) console.log("      <- STATIC importer:", imp)
          }
        }
      },
    },
  ],
})

process.exit(0)
