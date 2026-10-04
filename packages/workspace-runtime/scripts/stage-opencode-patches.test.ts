import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { stageOpenCodePatches } from "./stage-opencode-patches"

test("npm lifecycle applies the packaged installer to hoisted dependencies, idempotently and fail-closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-npm-patches-"))
  try {
    const owner = path.join(root, "node_modules/@claxedo/workspace-runtime")
    const output = path.join(owner, "dist/opencode-node")
    const staged = await stageOpenCodePatches(output)
    expect(Object.keys(staged.patches)).toHaveLength(5)
    for (const file of Object.values(staged.patches)) expect(fs.statSync(path.join(output, file)).size).toBeGreaterThan(0)
    fs.mkdirSync(path.join(owner, "scripts"), { recursive: true })
    fs.copyFileSync(path.join(import.meta.dirname, "install-opencode-node.mjs"), path.join(owner, "scripts/install-opencode-node.mjs"))
    fs.writeFileSync(path.join(output, "fixture.patch"),
      "diff --git a/value.js b/value.js\n--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-export default 1\n+export default 2\n")
    fs.writeFileSync(path.join(output, "package.json"), JSON.stringify({
      claxedoDependencyPatches: { "fixture@1.0.0": "fixture.patch" },
    }))
    const dependency = path.join(root, "node_modules/fixture")
    fs.mkdirSync(dependency)
    fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
    const value = path.join(dependency, "value.js")
    fs.writeFileSync(value, "export default 1\n")
    const installer = path.join(owner, "scripts/install-opencode-node.mjs")
    for (let run = 0; run < 2; run++) {
      execFileSync("node", [installer], { cwd: root, stdio: "pipe" })
      expect(fs.readFileSync(value, "utf8")).toBe("export default 2\n")
    }
    fs.writeFileSync(value, "export default 3\n")
    const drift = spawnSync("node", [installer], { cwd: root, encoding: "utf8" })
    expect(drift.status).not.toBe(0)
    expect(drift.stderr).toContain("does not apply cleanly")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
