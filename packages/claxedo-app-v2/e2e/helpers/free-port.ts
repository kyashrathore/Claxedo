import net from "node:net"

/** Reserve and release a loopback port: an ephemeral one, or `requested` if it is free. */
export async function freePort(requested = 0): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(requested, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a loopback port")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}
