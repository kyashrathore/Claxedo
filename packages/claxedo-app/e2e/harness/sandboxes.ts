import fs from "node:fs/promises"
import path from "node:path"

const STATE = ".docker-stand-in"

type Container = { id: string; pid: number }

async function containers(dataDir: string): Promise<Container[]> {
  const dir = path.join(dataDir, STATE)
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const files = names.filter((name) => name.endsWith(".json"))
  return Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Container))
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function stopSandboxes(dataDir: string) {
  for (const container of await containers(dataDir)) {
    if (container.pid && alive(container.pid)) process.kill(container.pid, "SIGKILL")
  }
}

export async function sandboxLog(dataDir: string, id: string) {
  return fs.readFile(path.join(dataDir, STATE, id, "runtime.log"), "utf8")
}
