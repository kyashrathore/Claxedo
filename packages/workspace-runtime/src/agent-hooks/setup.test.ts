import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { userHomeDir } from "@claxedo/helpers/path"
import { workspaceRuntimeDataDir } from "../env"
import { agentHookConfigPaths } from "./materialize-status-hooks"
import { setupAgentHooks } from "./setup"

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function fingerprint(homeDir: string) {
  return Object.fromEntries(Object.entries(agentHookConfigPaths(homeDir)).map(([runner, file]) => {
    if (!fs.existsSync(file)) return [runner, undefined]
    return [runner, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]
  }))
}

/** The home this process was launched with: Bun 1.3 reports the startup HOME here, not one the preload assigns. */
const accountHome = os.userInfo().homedir

test("agent hook setup writes every harness config under the test home and none under the account home", async () => {
  const home = userHomeDir()
  expect(contains(fs.realpathSync(os.tmpdir()), home)).toBe(true)
  expect(contains(accountHome, home)).toBe(false)
  expect(contains(home, workspaceRuntimeDataDir())).toBe(true)
  const before = fingerprint(accountHome)

  await setupAgentHooks({ port: 7860 })

  const written = agentHookConfigPaths(home)
  for (const file of Object.values(written)) expect({ file, exists: fs.existsSync(file) }).toEqual({ file, exists: true })
  expect(fs.readFileSync(written.codex, "utf8")).toContain(path.join(workspaceRuntimeDataDir(), "hooks", "notify.sh"))
  expect(fs.readFileSync(written.cursor, "utf8")).toContain(path.join(workspaceRuntimeDataDir(), "hooks", "cursor-hook.sh"))
  expect(fingerprint(accountHome)).toEqual(before)
})
