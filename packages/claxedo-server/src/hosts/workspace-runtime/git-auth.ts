import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

export async function configureRuntimeGitAuth(env: NodeJS.ProcessEnv) {
  const placeholder = env.CLAXEDO_GITHUB_CLONE_AUTH
  if (!placeholder) return
  if (/[\r\n]/.test(placeholder)) throw new Error("Invalid GitHub clone authorization header")
  const gitEnv = { ...env }
  delete gitEnv.GIT_INDEX_FILE
  delete gitEnv.GIT_AUTHOR_DATE
  // Git's URL matching confines the placeholder to HTTPS requests to github.com.
  // The provider substitutes the complete auth value, including its scheme.
  await run("git", [
    "config", "--global", "--replace-all", "http.https://github.com/.extraheader",
    `Authorization: ${placeholder}`,
  ], { env: gitEnv })
}
