import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const repoRoot = path.resolve(import.meta.dirname, "..")
const exampleDir = path.join(repoRoot, "examples", "extension-client")

async function runJsonCommand<T extends Record<string, unknown>>(env: NodeJS.ProcessEnv) {
  const child = spawn("bun", ["run", "start"], {
    cwd: exampleDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", (exitCode) => resolve(exitCode))
    child.once("error", reject)
  })
  if (code !== 0) throw new Error(`extension-client exited with ${code}\n${stdout}${stderr}`)
  const start = stdout.indexOf("{")
  const end = stdout.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) throw new Error(`extension-client did not emit JSON\n${stdout}${stderr}`)
  return JSON.parse(stdout.slice(start, end + 1)) as T
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-extension-client-smoke-"))
const workspaceDir = path.join(root, "workspace")
const homeDir = path.join(root, "home")
const dataRoot = path.join(root, "data")
const packagePath = path.join("agent-extensions", "review")

try {
  await fs.mkdir(path.join(workspaceDir, packagePath), { recursive: true })
  await fs.mkdir(homeDir, { recursive: true })
  await fs.writeFile(path.join(workspaceDir, packagePath, "SKILL.md"), "---\nname: review\n---\n")

  const output = await runJsonCommand<{
    mode: string
    install?: { id?: string; materialized?: { status?: string } }
    afterDisable?: { materialized?: { packages?: Record<string, { enabled?: boolean }> } }
    afterEnable?: { materialized?: { packages?: Record<string, { enabled?: boolean }> } }
    removed?: { status?: string }
    afterRemove?: { desired?: { installs?: unknown[] } }
    doctor?: { ok?: boolean }
  }>({
    ...process.env,
    CLAXEDO_WORKSPACE_DIR: workspaceDir,
    CLAXEDO_HOME_DIR: homeDir,
    CLAXEDO_DATA_DIR: dataRoot,
    CLAXEDO_EXTENSION_PACKAGE_PATH: packagePath,
    CLAXEDO_EXTENSION_ID: "review",
  })

  if (output.mode !== "extension-client") throw new Error(`unexpected mode: ${output.mode}`)
  if (output.install?.id !== "review" || output.install.materialized?.status !== "applied") {
    throw new Error(`install did not apply: ${JSON.stringify(output.install)}`)
  }
  if (output.afterDisable?.materialized?.packages?.review?.enabled !== false) {
    throw new Error(`disable did not update effective state: ${JSON.stringify(output.afterDisable)}`)
  }
  if (output.afterEnable?.materialized?.packages?.review?.enabled !== true) {
    throw new Error(`enable did not update effective state: ${JSON.stringify(output.afterEnable)}`)
  }
  if ((output.afterRemove?.desired?.installs ?? []).length !== 0) {
    throw new Error(`remove did not clear state: ${JSON.stringify({ removed: output.removed, afterRemove: output.afterRemove })}`)
  }
  if (output.doctor?.ok !== true) {
    throw new Error(`doctor reported unhealthy state: ${JSON.stringify(output.doctor)}`)
  }

  console.log(JSON.stringify({
    ok: true,
    workspaceDir,
    extensionId: "review",
  }))
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
