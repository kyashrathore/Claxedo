/**
 * Last hypothesis before building anything permanent: does the config/catalog
 * surface need a real global config file to exist?
 *
 * V2 docs put the global config at ~/.config/opencode/opencode.json. Every
 * probe so far ran with no such file. `ServerOptions.config` accepts
 * `{ directory, file, content, project }`, so try each.
 *
 *   node gate-global-config-file.mjs
 */
import { OpenCode } from "@opencode-ai/sdk"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const home = os.homedir()
const globalDir = path.join(home, ".config", "opencode")
const globalFile = path.join(globalDir, "opencode.json")
fs.mkdirSync(globalDir, { recursive: true })
if (!fs.existsSync(globalFile)) {
  fs.writeFileSync(globalFile, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
  console.log("created", globalFile)
} else {
  console.log("exists", globalFile)
}

async function run(label, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-gc-"))
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  console.log(`\n[${label}]`)
  try {
    const oc = await OpenCode.create({
      database: { path: path.join(root, "c.db") },
      ...(config ? { config } : {}),
    })
    for (const [name, call] of [
      ["config.get", () => oc.config.get({ location: { directory: ws } })],
      ["provider.list", () => oc.provider.list({ location: { directory: ws } })],
      ["agent.list", () => oc.agent.list({ location: { directory: ws } })],
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
    console.log("  CREATE FAILED", String(error).slice(0, 200))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

await run("global config file now exists, no config option", undefined)
await run("config.directory = global dir", { directory: globalDir })
await run("config.file = global file", { file: globalFile })
await run("config.content inline", { content: JSON.stringify({ $schema: "https://opencode.ai/config.json" }) })
await run("config.project = false", { project: false })
