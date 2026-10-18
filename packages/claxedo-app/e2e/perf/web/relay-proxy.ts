import { createServer } from "node:http"
import { forward, forwardUpgrade } from "../../harness/proxy"
import { listenOnLoopback } from "../../../../harness/e2e/harness/ports"

export type RelayProxy = { readonly url: string; close(): Promise<void> }

export async function startRelayProxy(input: { port: number; relayPort: number; delayMs: () => number }): Promise<RelayProxy> {
  const target = new URL(`http://127.0.0.1:${input.relayPort}`)
  const held = (run: () => void) => {
    const delay = input.delayMs()
    if (delay > 0) setTimeout(run, delay)
    else run()
  }
  const server = createServer((request, response) => held(() => forward(request, response, target)))
  server.on("upgrade", (request, socket, head) => held(() => forwardUpgrade(request, socket, head, target)))
  await listenOnLoopback(server, input.port)
  return {
    url: `http://127.0.0.1:${input.port}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
