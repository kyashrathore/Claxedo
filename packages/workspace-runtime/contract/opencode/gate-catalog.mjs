/**
 * Contract doc gate: what do the catalog/config surfaces require?
 *
 * Session CRUD works on a bare host, but `config.get`, `provider.list`,
 * `model.list` and `integration.list` returned HTTP 500. Ruled out already:
 * it is not our Node bundle (identical under Bun with a direct package
 * import) and it is not egress (Node fetch reaches models.dev with status
 * 200 from this same environment). This probe isolates what the surfaces
 * actually need — a git-backed project, an explicit config directory, or a
 * models catalog — so R7 and Unit 7 know the real requirement.
 *
 *   node gate-catalog.mjs
 */
import { OpenCode } from "./dist-node/sdk-entry.js"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

async function scenario(label, { git, configDirectory, models }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-catalog-"))
  const ws = path.join(root, "ws")
  fs.mkdirSync(ws)
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: ws })
    fs.writeFileSync(path.join(ws, "README.md"), "# probe\n")
    execFileSync("git", ["add", "."], { cwd: ws })
    execFileSync("git", ["-c", "user.email=p@p", "-c", "user.name=p", "commit", "-qm", "init"], { cwd: ws })
  }
  try {
    const oc = await OpenCode.create({
      database: { path: path.join(root, "contract.db") },
      ...(configDirectory ? { config: { directory: ws } } : {}),
      ...(models ? { models } : {}),
    })
    for (const [name, run] of [
      ["config.get", () => oc.config.get({ location: { directory: ws } })],
      ["model.list", () => oc.model.list({ location: { directory: ws } })],
      ["provider.list", () => oc.provider.list({ location: { directory: ws } })],
      ["integration.list", () => oc.integration.list({ location: { directory: ws } })],
    ]) {
      try {
        const value = await run()
        const rows = value?.data ?? value
        console.log(`  OK  ${name}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 160))
      } catch (error) {
        console.log(`  ERR ${name}`, error?.reason ?? "", JSON.stringify(error?.cause ?? {}))
      }
    }
    await oc.close()
  } catch (error) {
    console.log(`  ERR OpenCode.create`, String(error).slice(0, 160))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

console.log("[bare directory]")
await scenario("bare", {})
console.log("[git-backed project]")
await scenario("git", { git: true })
console.log("[git + explicit config.directory]")
await scenario("git+config", { git: true, configDirectory: true })
console.log("[git + config + models.fetch=false]")
await scenario("all", { git: true, configDirectory: true, models: { fetch: false } })
