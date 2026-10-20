// Imports an instrumented Wrangler bundle (attribute-startup.py) under Node and prints its
// global-scope evaluation per module and per package, with the compile time as the rest of the import.
//
//   python3 attribute-startup.py <bundle.js> /tmp/instrumented.mjs "$PWD/cf-stub.mjs"
//   node attribute-startup.mjs /tmp/instrumented.mjs [top]
//
// Output goes through a file descriptor captured before the import: the bundle's unenv layer
// replaces process.stdout with a stub once it evaluates.
import fs from "node:fs"
import { performance } from "node:perf_hooks"

const out = (line) => fs.writeSync(1, `${line}\n`)
const [file, top = "40"] = process.argv.slice(2)
const t0 = performance.now()
await import(file)
const total = performance.now() - t0
const marks = globalThis.__t
const end = globalThis.__tEnd
const rows = marks.map(([module, at], i) => [module, (i + 1 < marks.length ? marks[i + 1][1] : end) - at])
const evalMs = end - globalThis.__t0
out(`import total ${total.toFixed(1)} ms; global-scope evaluation ${evalMs.toFixed(1)} ms across ${marks.length} module headers (compile ~${(total - evalMs).toFixed(1)} ms)`)
const byPackage = new Map()
for (const [module, ms] of rows) {
  const match = /node_modules\/\.bun\/[^/]+\/node_modules\/((@[^/]+\/)?[^/]+)/.exec(module)
  const key = match ? `pkg:${match[1]}` : module.replace(/^(\.\.\/)+/, "").split("/").slice(0, 3).join("/")
  byPackage.set(key, (byPackage.get(key) ?? 0) + ms)
}
out("--- by package / directory (ms of global-scope evaluation; a header's time includes the lazy modules it initializes)")
for (const [key, ms] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, Number(top))) out(`${ms.toFixed(2).padStart(8)}  ${key}`)
out("--- top modules")
for (const [module, ms] of rows.sort((a, b) => b[1] - a[1]).slice(0, Number(top))) out(`${ms.toFixed(2).padStart(8)}  ${module}`)
