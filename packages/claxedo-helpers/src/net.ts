import { createServer } from "node:net"

/**
 * Binds a TCP server to 127.0.0.1 on `requested` (0 lets the OS pick an
 * ephemeral port), reads the assigned port, closes, and returns it. Passing a
 * concrete port asserts that exact port is bindable and returns it unchanged.
 *
 * The loopback-only bind is deliberate: it is the interface every caller then
 * starts its own server on.
 */
export function freePort(requested = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(requested, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("freePort: server reported no TCP address")))
        return
      }
      const { port } = address
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}
