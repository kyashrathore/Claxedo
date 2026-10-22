import { execSync } from "node:child_process"
import { Miniflare, type MiniflareOptions } from "miniflare"

/**
 * Booting a real workerd for the tests in this package that need one.
 *
 * Under bun 1.3.14 on Linux, a workerd spawned in a process where an earlier
 * workerd was disposed or killed can have its pipes closed under it: the spawn
 * throws EBADF or "Failed to connect", or workerd reports "Broken pipe; fd = 3"
 * on its control pipe and never announces its ports. `Miniflare#setOptions()`
 * fails under bun as well ("this.#runtimeDispatcher?.close is not a function").
 * So a process boots workerd once: `scripts/test-workerd.mjs` runs each test
 * file in its own `bun test` process, and each file boots one Miniflare in
 * `beforeAll` that hosts every configuration it needs as separate workers.
 *
 * Miniflare awaits workerd's port announcement with no deadline, so a runtime
 * that never comes up would surface as a test timeout; the boot is bounded and
 * fails naming itself instead.
 */
const BOOT_DEADLINE_MS = 20_000

/**
 * Kill this process's workerd children. `bun test` exits without running
 * `process.on("exit")` handlers, so a child left running would outlive the
 * run. Only direct children of this process whose command line names workerd
 * can match.
 */
export function reapWorkerd() {
  try {
    execSync(`pkill -9 -P ${process.pid} -f workerd`, { stdio: "ignore" })
  } catch {
    // pkill exits non-zero when nothing matched; there is nothing to do.
  }
}

/** Boots workerd once per process; tear it down with `reapWorkerd()`. */
export async function bootWorkerd(options: MiniflareOptions): Promise<Miniflare> {
  const mf = new Miniflare(options)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      mf.ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`workerd did not report its ports within ${BOOT_DEADLINE_MS}ms`)), BOOT_DEADLINE_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  return mf
}
