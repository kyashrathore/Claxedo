import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, expect, test } from "vitest"
import { setupAgentHooks } from "@claxedo/workspace-runtime/host"
import { dataDir, stateDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { agentHookConfigPaths } from "../../../workspace-runtime/src/agent-hooks/materialize-status-hooks"
import { ClaxedoDB } from "../platform/db"

/**
 * Asserted against the resolvers the stores call, not against the variables
 * `data-isolation.ts` assigns: only the resolver proves the redirect reaches
 * the path a database is actually opened at.
 */
function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function fingerprint(homeDir: string) {
  return Object.fromEntries(Object.entries(agentHookConfigPaths(homeDir)).map(([runner, file]) => [
    runner,
    existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined,
  ]))
}

/** The passwd home: `data-isolation.ts` has already pointed HOME, and so `os.homedir()`, at the temporary root. */
const home = os.userInfo().homedir
const temporary = realpathSync(os.tmpdir())

afterAll(() => ClaxedoDB.close())

test("every data root a store resolves stays in temporary storage outside the real application profiles", () => {
  for (const resolved of [dataDir(), stateDir(), ClaxedoDB.Path()]) {
    for (const profile of [".claxedo", ".workspace-runtime"]) {
      expect(contains(path.join(home, profile), resolved)).toBe(false)
    }
    expect({ resolved, inTemporary: contains(temporary, resolved) }).toEqual({ resolved, inTemporary: true })
  }
})

test("opening the database creates the file under the temporary root", () => {
  ClaxedoDB.raw()

  const opened = ClaxedoDB.Path()
  expect(existsSync(opened)).toBe(true)
  expect(contains(temporary, opened)).toBe(true)
})

test("agent hook setup rewrites the harness configs under the temporary home, not the real one", async () => {
  expect(contains(temporary, os.homedir())).toBe(true)
  const before = fingerprint(home)

  await setupAgentHooks({ port: 7860 })

  const written = agentHookConfigPaths(os.homedir())
  for (const file of Object.values(written)) expect({ file, exists: existsSync(file) }).toEqual({ file, exists: true })
  const workspaceRuntime = process.env.WORKSPACE_RUNTIME_DATA_DIR!
  expect(readFileSync(written.gemini, "utf8")).toContain(path.join(workspaceRuntime, "hooks", "gemini-hook.sh"))
  expect(readFileSync(path.join(workspaceRuntime, "hooks", "claude-settings.json"), "utf8")).toContain(path.join(workspaceRuntime, "hooks", "notify.sh"))
  expect(fingerprint(home)).toEqual(before)
})
