import { createServer } from "node:http"
import { startEgressGuard, egressProxyEnv } from "../egress-guard"
import { loadCursorDescriptors } from "./descriptors"

const port = Number(process.env.CURSOR_PROBE_PORT ?? 48501)
const guard = await startEgressGuard(port + 1)
Object.assign(process.env, egressProxyEnv(guard.url))
process.env.CURSOR_BACKEND_URL = `http://127.0.0.1:${port}`
const descriptors = await loadCursorDescriptors()
const requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; decoded: unknown }> = []
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  const [serviceName, methodName] = (request.url ?? "").slice(1).split("/")
  const servicePath = serviceName === "agent.v1.AgentService" ? "agent/v1/agent_service"
    : serviceName === "aiserver.v1.DashboardService" ? "aiserver/v1/dashboard"
    : serviceName === "aiserver.v1.ServerConfigService" ? "aiserver/v1/server-config"
    : serviceName === "aiserver.v1.BidiService" ? "aiserver/v1/bidi"
    : serviceName === "aiserver.v1.AnalyticsService" ? "aiserver/v1/analytics" : undefined
  const method = servicePath ? Object.values(descriptors.service(servicePath).methods).find((candidate) => candidate.name === methodName) : undefined
  const payload = request.headers["content-type"]?.startsWith("application/connect+") ? body.subarray(5) : body
  const decoded = method && request.headers["content-type"] !== "application/json"
    ? method.I.fromBinary(payload).toJson()
    : body.toString("utf8")
  requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, decoded })
  console.log(JSON.stringify({ request: requests.at(-1) }))
  if (process.env.CURSOR_PROBE_REFUSE === "1") {
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "scripted backend probe refusal" }))
    return
  }
  if (request.url === "/auth/exchange_user_api_key") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: "scripted-access-token" }))
  } else if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: [{ id: "scripted", displayName: "Scripted" }] }))
  } else if (request.url === "/agent.v1.AgentService/RunSSE" && method) {
    const frame = (flag: number, payload: Uint8Array) => {
      const header = Buffer.alloc(5)
      header[0] = flag
      header.writeUInt32BE(payload.length, 1)
      return Buffer.concat([header, Buffer.from(payload)])
    }
    response.writeHead(200, { "content-type": "application/connect+proto", "connect-protocol-version": "1" })
    setTimeout(() => {
      response.write(frame(0, method.O.fromJson({ interactionUpdate: { textDelta: { text: "PROBE-ANSWER" } } }).toBinary()))
      response.write(frame(0, method.O.fromJson({ interactionUpdate: { turnEnded: { inputTokens: "2", outputTokens: "3" } } }).toBinary()))
      response.end(frame(2, Buffer.from("{}")))
    }, 500)
  } else if (method && request.url !== "/agent.v1.AgentService/RunSSE") {
    response.writeHead(200, { "content-type": "application/proto" }).end(Buffer.from(method.O.fromJson({}).toBinary()))
  } else {
    response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "scripted backend probe refusal" }))
  }
})
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
try {
  const { Agent } = await import("@cursor/sdk")
  console.log("SDK imported")
  const agent = await Agent.create({ apiKey: "cursor-placeholder", model: { id: "scripted" }, local: { cwd: process.cwd() } })
  console.log(`Agent created ${agent.agentId}`)
  const run = await agent.send("PROBE-CURSOR")
  console.log(`Run created ${run.id}`)
  for await (const message of run.stream()) console.log(JSON.stringify({ message }))
  console.log(JSON.stringify({ result: await run.wait() }))
  agent.close()
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }))
} finally {
  console.log(JSON.stringify({ egress: guard.attempts }))
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await guard.close()
  await descriptors.close()
}
