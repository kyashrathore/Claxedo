import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import path from "node:path"
import { RUNTIME_PREPARATION_DEADLINE_MS } from "./boot-contract"

const SCRIPTS_DIRECTORY = ".claxedo"
const OUTPUT_TAIL_CHARS = 600

export type RepositoryScript = "setup.sh" | "start.sh"

export type RepositoryScriptOutput = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/**
 * The repository's own `.claxedo/<script>` as a step of this boot, or nothing
 * when the checkout has none. The script is the repository's code running
 * before any prompt, so `env` is the caller's agent-safe projection, never
 * the boot's own environment. It runs in the checkout and writes through to
 * the runtime's own output, so the container log carries it. A non-zero exit
 * fails the boot with the script's name, its code and the tail of what it
 * wrote, and a script still running at the preparation deadline is ended and
 * fails the same way.
 */
export async function repositoryScript(
  directory: string,
  script: RepositoryScript,
  env: Record<string, string>,
  output: RepositoryScriptOutput = process,
): Promise<(() => Promise<void>) | undefined> {
  const file = path.join(directory, SCRIPTS_DIRECTORY, script)
  try {
    await access(file)
  } catch {
    return undefined
  }
  return () => new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-e", file], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
    let tail = ""
    const through = (stream: NodeJS.WritableStream) => (chunk: Buffer) => {
      stream.write(chunk)
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
    }
    child.stdout.on("data", through(output.stdout))
    child.stderr.on("data", through(output.stderr))
    const deadline = setTimeout(() => child.kill("SIGKILL"), RUNTIME_PREPARATION_DEADLINE_MS)
    child.on("error", (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.on("close", (code, signal) => {
      clearTimeout(deadline)
      if (code === 0) return resolve()
      const outcome = code === null ? `was ended by ${signal}` : `exited ${code}`
      const wrote = tail.trim()
      reject(new Error(`${SCRIPTS_DIRECTORY}/${script} ${outcome}${wrote ? `: ${wrote}` : ""}`))
    })
  })
}
