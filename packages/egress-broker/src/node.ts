import { serve } from "@hono/node-server"
import { createEgressBroker, type BrokerOptions } from "./broker.js"

export async function listenLoopbackBroker(options: BrokerOptions & { port?: number }) {
  const server = serve({ fetch: createEgressBroker(options), hostname: "127.0.0.1", port: options.port ?? 0 })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Broker address unavailable")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}
