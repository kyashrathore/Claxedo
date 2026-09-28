import fs from "node:fs/promises"
import path from "node:path"
import { CLAXEDO_DAEMON_DISCOVERY_FILE } from "@claxedo/helpers/claxedo-daemon"
import { isMissingFile } from "@claxedo/helpers/fs"

const EXIT_GRACE_MS = 20_000
const EXIT_POLL_MS = 100

export async function desktopDaemonPid(serverDataDir: string): Promise<number | undefined> {
  const text = await fs.readFile(path.join(serverDataDir, CLAXEDO_DAEMON_DISCOVERY_FILE), "utf8").catch((error: unknown) => {
    if (isMissingFile(error)) return undefined
    throw error
  })
  if (text === undefined) return undefined
  const pid = (JSON.parse(text) as { pid?: unknown }).pid
  return typeof pid === "number" ? pid : undefined
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function daemonExited(pid: number): Promise<void> {
  const deadline = Date.now() + EXIT_GRACE_MS
  let killed = false
  while (alive(pid)) {
    if (!killed && Date.now() > deadline) {
      process.kill(pid, "SIGKILL")
      killed = true
    }
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS))
  }
}
