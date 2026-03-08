import { createServer } from "node:net"

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close()
        reject(new Error("Failed to get port from server address"))
        return
      }
      srv.close(() => resolve(addr.port))
    })
    srv.on("error", reject)
  })
}

/**
 * Find the PID of a process listening on a given port (macOS/Linux).
 * Returns undefined if not found.
 */
export async function findPidOnPort(port: number): Promise<number | undefined> {
  try {
    const { execSync } = await import("child_process")
    const cmd = process.platform === "darwin"
      ? `lsof -ti:${port}`
      : `fuser ${port}/tcp 2>/dev/null`
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim()
    const pid = parseInt(output.split("\n")[0], 10)
    return isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

/**
 * Try to bind to a specific port. Returns true if the port is free.
 */
export async function tryPort(port: number): Promise<boolean> {
  if (await findPidOnPort(port)) return false

  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true))
    })
    srv.on("error", () => resolve(false))
  })
}
