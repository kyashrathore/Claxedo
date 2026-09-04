/**
 * Decides whether the §2.2 500s are an SDK defect or a sandbox artifact.
 *
 * Plain `fetch("https://models.dev/api.json")` returns 200 from this same Node
 * process, but the host's internal HTTP client may not share that behaviour
 * through the agent proxy. `ServerOptions.models` accepts `{ url, file, fetch,
 * snapshot }`, so pointing `file` at a locally downloaded catalog removes the
 * network from the question entirely.
 *
 * If the surfaces come alive with a local catalog, this is an environment
 * problem and the cutover is NOT blocked.
 *
 *   node gate-models-file.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const catalog = process.env.MODELS_FILE ?? "/tmp/models-api.json"
console.log("catalog file:", catalog, fs.existsSync(catalog) ? `(${fs.statSync(catalog).size} bytes)` : "(MISSING)")

async function run(label, models) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-models-"))
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  console.log(`\n[${label}]`)
  try {
    const oc = await OpenCode.create({
      database: { path: path.join(root, "c.db") },
      ...(models ? { models } : {}),
    })
    for (const [name, call] of [
      ["config.get", () => oc.config.get({ location: { directory: ws } })],
      ["provider.list", () => oc.provider.list({ location: { directory: ws } })],
      ["model.list", () => oc.model.list({ location: { directory: ws } })],
      ["agent.list", () => oc.agent.list({ location: { directory: ws } })],
      ["location.get", () => oc.location.get({ directory: ws })],
    ]) {
      try {
        const value = await call()
        const rows = value?.data ?? value
        console.log(`  OK  ${name}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 200))
      } catch (error) {
        console.log(`  ERR ${name}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
      }
    }
    await oc.close()
  } catch (error) {
    console.log("  CREATE FAILED", String(error).slice(0, 260))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

await run("baseline (network catalog)", undefined)
await run("models.file = local catalog", { file: catalog })
await run("models.file + fetch:false", { file: catalog, fetch: false })
