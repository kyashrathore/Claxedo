import { createServer } from "node:http"
import { pathToFileURL } from "node:url"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const embedPath = process.env.CLAXEDO_ENGINE_EMBED_PATH
const dbPath = process.env.CLAXEDO_ENGINE_DB_PATH
const parentPid = Number(process.env.CLAXEDO_ENGINE_PARENT_PID)
if (!embedPath || !dbPath || !Number.isInteger(parentPid) || parentPid <= 0) {
  throw new Error("Claxedo engine worker is missing its startup configuration")
}

process.env.OPENCODE_DB = dbPath
const engine = await import(pathToFileURL(embedPath).href)
const handler = engine.Server.Default().app.fetch as (request: Request) => Response | Promise<Response>
const idleMs = Number(process.env.CLAXEDO_ENGINE_IDLE_MS) || 10_000
let activeRequests = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
let stopping = false

const server = createServer(async (incoming, outgoing) => {
  clearTimeout(idleTimer)
  activeRequests += 1
  try {
    const response = await handler(new Request(`http://opencode.internal${incoming.url ?? "/"}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
        ? {}
        : { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" as const }),
    }))
    const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers.entries())
    const cookies = response.headers.getSetCookie()
    if (cookies.length) responseHeaders["set-cookie"] = cookies
    outgoing.writeHead(response.status, response.statusText, responseHeaders)
    if (!response.body) {
      outgoing.end()
      return
    }
    await pipeline(Readable.fromWeb(response.body as never), outgoing)
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" })
    if (!outgoing.writableEnded) outgoing.end(JSON.stringify({ error: String(error) }))
  } finally {
    activeRequests -= 1
    scheduleIdleExit()
  }
})

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Claxedo engine worker failed to bind")
  process.send?.({ type: "claxedo-engine-ready", port: address.port })
  scheduleIdleExit()
})

const parentWatch = setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") return
    void stop()
  }
}, 250)
parentWatch.unref()

process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())

function scheduleIdleExit() {
  clearTimeout(idleTimer)
  if (activeRequests || stopping) return
  idleTimer = setTimeout(() => void stop(), idleMs)
  idleTimer.unref()
}

async function stop() {
  if (stopping) return
  stopping = true
  clearInterval(parentWatch)
  clearTimeout(idleTimer)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await engine.InstanceRuntime.disposeAllInstances()
  process.exit(0)
}
