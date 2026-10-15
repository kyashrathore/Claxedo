import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

// Keyed to the one repository URL the credential is scoped to: git sends a
// `http.<url>` header to every URL under that path and to no other, so a
// clone of any other repository goes out anonymous rather than presenting a
// placeholder the broker refuses.
const headerKey = (url: string) => `http.${url}.extraheader`
const rewriteKey = (url: string) => `url.${url}.insteadOf`

// `git config --unset-all` exits 5 when the key is not there and
// `--get-regexp` exits 1 when nothing matches, which is the ordinary case on a
// sandbox that never held a clone credential.
const NOTHING_TO_UNSET = 5
const NOTHING_MATCHED = 1

type GitEnv = NodeJS.ProcessEnv

function gitExitCode(err: unknown) {
  return err instanceof Error ? (err as Error & { code?: unknown }).code : undefined
}

async function unset(key: string, env: GitEnv) {
  await run("git", ["config", "--global", "--unset-all", key], { env }).catch((err: unknown) => {
    // No git in the image means no git config was ever written, so there is
    // nothing left to withdraw. Every other failure is a header we cannot
    // prove is gone.
    const code = gitExitCode(err)
    if (code === NOTHING_TO_UNSET || code === "ENOENT") return
    throw err
  })
}

/** The broker URLs an earlier boot rewrote this repository to. */
async function brokeredRewrites(repoUrl: string, env: GitEnv) {
  const listed = await run("git", ["config", "--global", "--get-regexp", "^url\\..*\\.insteadof$"], { env }).catch((err: unknown) => {
    const code = gitExitCode(err)
    if (code === NOTHING_MATCHED || code === "ENOENT") return { stdout: "" }
    throw err
  })
  return listed.stdout.split("\n").flatMap((line) => {
    const match = /^url\.(.+)\.insteadof (.+)$/.exec(line.trim())
    return match?.[2] === repoUrl ? [match[1]] : []
  })
}

/** Where git fetches and pushes the repository through the broker: the binding URL followed by the repository's path. */
function brokeredRepositoryUrl(brokerUrl: string, repoUrl: string) {
  const broker = new URL(brokerUrl)
  const loopback = broker.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(broker.hostname)
  if ((broker.protocol !== "https:" && !loopback) || broker.username || broker.password || broker.search || broker.hash) {
    throw new Error("Invalid GitHub clone broker URL")
  }
  return `${broker.origin}${broker.pathname.replace(/\/+$/, "")}${new URL(repoUrl).pathname}`
}

/**
 * Installs the clone credential the control plane delivered for the
 * workspace repository, and removes whatever an earlier boot installed.
 *
 * With a provider edge, `CLAXEDO_GITHUB_CLONE_AUTH` is a placeholder the edge
 * swaps on the way to the repository host. Without one,
 * `CLAXEDO_GITHUB_CLONE_BROKER_URL` names the plane's broker: git is pointed
 * there for this repository alone, the origin recorded in the checkout stays
 * the repository's own URL, and the placeholder is the broker's pass.
 */
export async function configureRuntimeGitAuth(env: NodeJS.ProcessEnv) {
  const placeholder = env.CLAXEDO_GITHUB_CLONE_AUTH
  const brokerUrl = env.CLAXEDO_GITHUB_CLONE_BROKER_URL?.trim()
  if (placeholder && /[\r\n]/.test(placeholder)) {
    throw new Error("Invalid GitHub clone authorization header")
  }
  if (brokerUrl && !placeholder) throw new Error("A GitHub clone broker names no authorization")
  const repoUrl = env.WORKSPACE_RUNTIME_GIT_REPO_URL?.trim()
  if (!repoUrl) {
    if (placeholder) throw new Error("A GitHub clone authorization names no repository")
    return
  }
  const requestUrl = brokerUrl ? brokeredRepositoryUrl(brokerUrl, repoUrl) : repoUrl
  const gitEnv = { ...env }
  delete gitEnv.GIT_INDEX_FILE
  delete gitEnv.GIT_AUTHOR_DATE
  // Git resolves its global config from GIT_CONFIG_GLOBAL, else HOME. With
  // neither, no earlier boot can have written a credential there, and asking
  // git to remove one fails with "$HOME not set".
  const configured = !!gitEnv.GIT_CONFIG_GLOBAL || !!gitEnv.HOME
  // Withdrawal. A sandbox that wakes without the placeholder, or with it in
  // the other form, was told to stop using what an earlier boot wrote; that
  // config survives the restart, so leaving it is the sandbox keeping an
  // authority the control plane took away.
  if (configured) {
    for (const rewritten of await brokeredRewrites(repoUrl, gitEnv)) {
      if (rewritten === requestUrl && brokerUrl) continue
      await unset(rewriteKey(rewritten), gitEnv)
      await unset(headerKey(rewritten), gitEnv)
    }
    if (brokerUrl || !placeholder) await unset(headerKey(repoUrl), gitEnv)
  }
  if (!placeholder) return
  if (brokerUrl) await run("git", ["config", "--global", "--replace-all", rewriteKey(requestUrl), repoUrl], { env: gitEnv })
  await run("git", [
    "config", "--global", "--replace-all", headerKey(requestUrl),
    `Authorization: ${placeholder}`,
  ], { env: gitEnv })
}
