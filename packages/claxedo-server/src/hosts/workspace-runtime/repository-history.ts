import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { promisify } from "node:util"
import { lstatIfExists, readTextIfExists } from "@claxedo/helpers/fs"
import { asRecord } from "@claxedo/helpers/guards"
import { createBoundedGit, GIT_CLONE_TIMEOUT_MS } from "@claxedo/workspace-runtime/host"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const git = createBoundedGit({ timeoutMs: GIT_CLONE_TIMEOUT_MS })
const run = promisify(execFile)
const log = Log.create({ service: "runtime-repository-history" })

// `--deepen` counts generations along every parent, so a step brings at most
// this many generations of the branch, more commits where merges fan out.
const HISTORY_STEP_GENERATIONS = 1_000
// Spaces the steps, so a long history is never back-to-back fetches against
// the repository host; also how long the loop waits on another git's lock.
const HISTORY_STEP_PAUSE_MS = 5_000

export type RepositoryHistory = {
  /** Begins the steps once; settles when they end. */
  start(): Promise<void>
  stop(): Promise<void>
}

async function shallowFile(directory: string) {
  return path.resolve(directory, (await git(["rev-parse", "--git-path", "shallow"], directory)).trim())
}

function heldLock(error: unknown) {
  const stderr = asRecord(error)?.stderr
  return /shallow\.lock/.test(typeof stderr === "string" ? stderr : String(error))
}

/**
 * Deepens the selected branch of a checkout that began at its tip, a step at a
 * time, after the runtime serves. It ends when the checkout is complete, when a
 * step brings nothing (the commit it began from is gone from the repository),
 * at the first failure, or at `stop`, which ends the running git process with
 * its lock. While another git holds `shallow.lock` it waits instead of
 * fetching, and a step that meets the lock mid-fetch waits and tries again
 * rather than failing. Each step first re-checks that the checkout is still
 * shallow, because a deepen of a complete checkout would cut its history.
 */
export function repositoryHistory(
  directory: string,
  branch: string,
  options: { pauseMs?: number } = {},
): RepositoryHistory {
  const pauseMs = options.pauseMs ?? HISTORY_STEP_PAUSE_MS
  const abort = new AbortController()
  const { signal } = abort
  const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  let running: Promise<void> | undefined
  const betweenSteps = () => wait(pauseMs, undefined, { signal }).catch(() => undefined)

  async function deepen() {
    const shallow = await shallowFile(directory)
    while (!signal.aborted) {
      if ((await git(["rev-parse", "--is-shallow-repository"], directory, { signal })).trim() !== "true") return
      if (await lstatIfExists(`${shallow}.lock`)) {
        await betweenSteps()
        continue
      }
      const before = await readTextIfExists(shallow)
      if (before === undefined) return
      try {
        await git(["fetch", "--quiet", "--no-auto-maintenance", `--deepen=${HISTORY_STEP_GENERATIONS}`, "origin", refspec], directory, { signal })
      } catch (error) {
        if (!heldLock(error)) throw error
        await betweenSteps()
        continue
      }
      if (await readTextIfExists(shallow) === before) {
        log.warn("repository history stopped: a step brought nothing", { branch })
        return
      }
      await betweenSteps()
    }
  }

  return {
    start() {
      running ??= deepen().catch((error: unknown) => {
        if (signal.aborted) return
        log.warn("repository history fetch stopped", { error: error instanceof Error ? error.message : String(error) })
      })
      return running
    },
    async stop() {
      abort.abort()
      await running
    },
  }
}

async function gitProcessRunning() {
  const { stdout } = await run("ps", ["-A", "-o", "comm="])
  return stdout.split("\n").some((name) => path.basename(name.trim()).startsWith("git"))
}

/**
 * Removes a `shallow.lock` that no git process can hold. A runtime killed
 * outright leaves its fetch's lock behind, a checkpoint can carry it, and every
 * later fetch of the checkout, the person's included, fails on it.
 */
export async function clearStaleShallowLock(directory: string) {
  const lock = `${await shallowFile(directory)}.lock`
  if (!await lstatIfExists(lock) || await gitProcessRunning()) return
  await rm(lock, { force: true })
  log.warn("removed a stale shallow.lock", { lock })
}
