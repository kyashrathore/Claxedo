import type { IPty } from "@lydell/node-pty"
import { isRecord } from "@claxedo/helpers/guards"

/**
 * Releases a terminal's native handle without signalling any process by pid.
 *
 * On Windows, @lydell/node-pty 1.2.0-beta.14's `kill()` forks a helper that
 * attaches to the console of the shell's pid, then kills every pid it lists,
 * and after 5 s without an answer kills the shell's pid itself. Once the shell
 * has exited, that pid can belong to another process. The terminal's job
 * already ends every process the shell started, so the listing is replaced
 * with an empty one and `kill()` only closes the pseudoconsole and its pipes.
 */
export function closeNativeTerminal(pty: IPty, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") {
    const agent = isRecord(pty) ? pty._agent : undefined
    if (!isRecord(agent) || typeof agent._getConsoleProcessList !== "function") {
      throw new Error("node-pty's Windows agent no longer lists console processes through _getConsoleProcessList; its kill() was not called")
    }
    agent._getConsoleProcessList = () => Promise.resolve([])
  }
  pty.kill()
}
