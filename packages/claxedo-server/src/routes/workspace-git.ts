import fs from "fs/promises"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export function repoNameFromUrl(repoUrl: string | undefined) {
  const trimmed = repoUrl?.trim()
  if (!trimmed) return
  const last = trimmed.replace(/\.git$/, "").split("/").pop()
  return last && last.length > 0 ? last : undefined
}

export async function cloneRepo(repo: string, dir: string) {
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await execFileAsync("git", ["clone", repo, dir])
}

export async function addWorktree(base: string, dir: string) {
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await execFileAsync("git", ["-C", base, "worktree", "add", dir])
}
