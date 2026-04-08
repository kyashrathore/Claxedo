import { createServer } from "net"

/**
 * Find a free port by binding to port 0 and reading the assigned port.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        reject(new Error("Failed to get port from server address"))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}

/**
 * Replace `{{port:name}}` templates in env values with port numbers from the map.
 * Unknown names are left as-is.
 */
export function resolvePortTemplates(
  env: Record<string, string>,
  portMap: Record<string, number>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\{\{port:([a-zA-Z0-9._-]+)\}\}/g, (_match, name) => {
      const port = portMap[name]
      return port !== undefined ? String(port) : _match
    })
  }
  return result
}

/**
 * Returns true if the inject string is a CLI flag (starts with "-").
 */
export function isFlag(inject: string): boolean {
  return inject.startsWith("-")
}
