import { createServer, request as httpRequest, type IncomingMessage } from "node:http"
import { sleep } from "./pipes"

export type VendorRequestRecord = {
  arrivedAt: number
  forwardedAt?: number
  firstByteAt?: number
  chunks: number[]
  endedAt?: number
}

export type VendorProxy = {
  url: string
  v1Url: string
  port: number
  requests: VendorRequestRecord[]
  close(): Promise<void>
}

async function readBody(incoming: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of incoming) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(parts)
}

/**
 * The vendor as the model caller sees it: the scripted model server behind a
 * link of `oneWayMs` each way. Every response chunk is stamped when the vendor
 * emitted it, before the link's delay, so a delta's time at the vendor can be
 * set against its time at the harness and at the person.
 */
export async function startVendorProxy(input: { targetPort: number; oneWayMs: number }): Promise<VendorProxy> {
  const requests: VendorRequestRecord[] = []
  const server = createServer(async (incoming, outgoing) => {
    const record: VendorRequestRecord = { arrivedAt: performance.now(), chunks: [] }
    requests.push(record)
    const body = await readBody(incoming)
    await sleep(input.oneWayMs)
    record.forwardedAt = performance.now()
    const upstream = httpRequest({ host: "127.0.0.1", port: input.targetPort, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: `127.0.0.1:${input.targetPort}` } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      let chain = Promise.resolve()
      response.on("data", (chunk: Buffer) => {
        const at = performance.now()
        record.firstByteAt ??= at
        record.chunks.push(at)
        chain = chain.then(() => sleep(Math.max(0, input.oneWayMs - (performance.now() - at)))).then(() => { outgoing.write(chunk) })
      })
      response.on("end", () => {
        record.endedAt = performance.now()
        void chain.then(() => outgoing.end())
      })
    })
    upstream.on("error", () => { outgoing.writeHead(502).end() })
    upstream.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The vendor proxy is not listening on a port")
  const url = `http://127.0.0.1:${address.port}`
  return {
    url, v1Url: `${url}/v1`, port: address.port, requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
