import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const IDENTITY = ["-c", "user.email=e2e@claxedo.test", "-c", "user.name=Claxedo e2e", "-c", "commit.gpgsign=false"]

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env, GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined, GIT_AUTHOR_DATE: undefined }
  const { stdout } = await execFileAsync("git", [...IDENTITY, ...args], { cwd, env })
  return stdout
}

export async function initRepository(directory: string, name: string) {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
  await git(directory, "init", "-q")
  await git(directory, "add", "--", "README.md")
  await git(directory, "commit", "-q", "-m", "init", "--", "README.md")
}

export async function gitFolder(root: string, name: string): Promise<string> {
  const directory = path.join(root, name)
  await initRepository(directory, name)
  return fs.realpath(directory)
}
