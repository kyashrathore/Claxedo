import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

// Keyed to the one repository the brokered credential is scoped to: git sends
// a `http.<url>` header to every URL under that path and to no other, so a
// clone of any other github.com repository goes out anonymous rather than
// presenting a placeholder the broker refuses.
const headerKey = (repoUrl: string) => `http.${repoUrl}.extraheader`

// `git config --unset-all` exits 5 when the key is not there, which is the
// ordinary case on a sandbox that never held a clone token.
const NOTHING_TO_UNSET = 5

export async function configureRuntimeGitAuth(env: NodeJS.ProcessEnv) {
  const placeholder = env.CLAXEDO_GITHUB_CLONE_AUTH
  if (placeholder && /[\r\n]/.test(placeholder)) {
    throw new Error("Invalid GitHub clone authorization header")
  }
  const repoUrl = env.WORKSPACE_RUNTIME_GIT_REPO_URL?.trim()
  if (!repoUrl) {
    if (placeholder) throw new Error("A GitHub clone authorization names no repository")
    return
  }
  const gitEnv = { ...env }
  delete gitEnv.GIT_INDEX_FILE
  delete gitEnv.GIT_AUTHOR_DATE
  // Withdrawal. A sandbox that wakes without the placeholder was told to stop
  // using that credential; the header an earlier boot wrote survives the
  // restart, so leaving it is the sandbox keeping an authority the control
  // plane took away.
  if (!placeholder) {
    // Git resolves its global config from GIT_CONFIG_GLOBAL, else HOME. With
    // neither, no earlier boot can have written a header there, and asking git
    // to unset one fails with "$HOME not set".
    if (!gitEnv.GIT_CONFIG_GLOBAL && !gitEnv.HOME) return
    await run("git", ["config", "--global", "--unset-all", headerKey(repoUrl)], { env: gitEnv })
      .catch((err: unknown) => {
        // No git in the image means no git config was ever written, so there is
        // nothing left to withdraw. Every other failure is a header we cannot
        // prove is gone.
        const code = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined
        if (code === NOTHING_TO_UNSET || code === "ENOENT") return
        throw err
      })
    return
  }
  // The provider substitutes the complete auth value, including its scheme.
  await run("git", [
    "config", "--global", "--replace-all", headerKey(repoUrl),
    `Authorization: ${placeholder}`,
  ], { env: gitEnv })
}
