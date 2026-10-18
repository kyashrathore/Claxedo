import { existsSync } from "node:fs"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Agent App Benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
  GIT_COMMITTER_NAME: "Agent App Benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
}

async function gitInWorkspace(args: string[], cwd: string) {
  const child = Bun.spawn({ cmd: ["git", ...args], cwd, env: { ...process.env, ...GIT_IDENTITY }, stdout: "pipe", stderr: "pipe" })
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${stderr.trim()}`)
}

export async function createWorkspaceRepository(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!existsSync(path.join(directory, ".git", "HEAD"))) {
    await writeFile(path.join(directory, "README.md"), `# Benchmark ${path.basename(directory)}\n`)
    await gitInWorkspace(["init", "-q"], directory)
    await gitInWorkspace(["add", "README.md"], directory)
    await gitInWorkspace(["commit", "-q", "-m", "benchmark workspace"], directory)
  }
  return realpath(directory)
}
