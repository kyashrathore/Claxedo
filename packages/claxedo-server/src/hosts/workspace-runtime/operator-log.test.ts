import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setOperatorLogSink } from "@claxedo/helpers/operator-log"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { afterEach, expect, test, vi } from "vitest"
import { WORKSPACE_RUNTIME_OPERATOR_LOG } from "./boot-contract"
import { claimOperatorLog } from "./operator-log"
import { claxedoWorkspaceRuntimeBootFromEnv } from "./runtime-boot"

let directory: string | undefined
afterEach(() => {
  setOperatorLogSink(undefined)
  vi.restoreAllMocks()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function operatorLog() {
  directory = mkdtempSync(path.join(tmpdir(), "operator-log-"))
  return path.join(directory, "operator.log")
}

test("the runtime takes its operator log out of the environment its children inherit, and only its own warnings and errors land there", () => {
  const file = operatorLog()
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, [WORKSPACE_RUNTIME_OPERATOR_LOG]: file }
  claimOperatorLog(env)
  expect(env).not.toHaveProperty(WORKSPACE_RUNTIME_OPERATOR_LOG)
  const child = spawnSync(process.execPath, ["-e", `process.stderr.write("harness: " + (process.env.${WORKSPACE_RUNTIME_OPERATOR_LOG} ?? "no operator log") + "\\n")`], { env, encoding: "utf8" })
  expect(child.stderr).toBe("harness: no operator log\n")
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const log = Log.create({ service: "session-authority" })
  log.info("prompt received", { text: "the person's prompt" })
  log.warn("Session authority unavailable", { action: "write", ms: 5003, cause: "timeout" })
  expect(readFileSync(file, "utf8")).toMatch(/^\S+ WARN  Session authority unavailable service=session-authority action=write ms=5003 cause=timeout\n$/)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("a boot claims the operator log before it runs anything", async () => {
  const file = operatorLog()
  const home = path.join(directory ?? "", "home")
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(directory ?? "", "gitconfig"),
    WORKSPACE_RUNTIME_WORKSPACE_ID: "ws-operator-log",
    WORKSPACE_RUNTIME_DIRECTORY: home,
    [WORKSPACE_RUNTIME_OPERATOR_LOG]: file,
  }
  await claxedoWorkspaceRuntimeBootFromEnv(env).catch(() => undefined)
  expect(env).not.toHaveProperty(WORKSPACE_RUNTIME_OPERATOR_LOG)
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  Log.create({ service: "boot" }).error("after boot")
  expect(readFileSync(file, "utf8")).toContain("ERROR after boot service=boot")
})
