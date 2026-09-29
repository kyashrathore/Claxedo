import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { listenOnLoopback } from "../ports"
import { loadCursorDescriptors, type CursorDescriptors } from "./descriptors"

export type CursorToolStep = { kind: "tool"; tool: string; args: unknown; result?: unknown }

export type CursorScript = {
  steps: Array<{ kind: "text"; text: string } | { kind: "thinking"; text: string; durationMs: number } | { kind: "read"; path: string; result: string } | { kind: "wait"; ms: number } | CursorToolStep>
  usage?: { inputTokens: number; outputTokens: number }
  error?: { status: number; message: string }
  hold?: boolean
}

export type CursorRunRequest = { requestId: string; run: unknown }

export type CursorCatalogModel = { id: string; displayName: string; description?: string }

const DEFAULT_CATALOG: CursorCatalogModel[] = [{ id: "scripted", displayName: "Scripted" }, { id: "auto", displayName: "Auto" }]

export type CursorRequest = {
  path: string
  method: string
  contentType: string | undefined
  headers: IncomingMessage["headers"]
  decoded: unknown
}

export type ScriptedCursorBackend = {
  url: string
  requests: CursorRequest[]
  runs: CursorRunRequest[]
  script(name: string, script: CursorScript): void
  defaultScript(name: string): void
  models(items: CursorCatalogModel[]): void
  refuseRun(name: string, status: number): void
  refusePath(path: string, status: number): void
  release(name: string): void
  close(): Promise<void>
}

type PendingStream = { response: ServerResponse; script?: CursorScript; name?: string }

const SERVICE_PATHS: Record<string, string> = {
  "agent.v1.AgentService": "agent/v1/agent_service",
  "aiserver.v1.DashboardService": "aiserver/v1/dashboard",
  "aiserver.v1.ServerConfigService": "aiserver/v1/server-config",
  "aiserver.v1.BidiService": "aiserver/v1/bidi",
  "aiserver.v1.AnalyticsService": "aiserver/v1/analytics",
}

function frame(flag: number, payload: Uint8Array) {
  const header = Buffer.alloc(5)
  header[0] = flag
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, Buffer.from(payload)])
}

function scriptName(prompt: unknown) {
  const match = JSON.stringify(prompt).match(/CURSOR_SCRIPT:([a-z0-9-]+)/)
  return match?.[1]
}

function readBody(incoming: IncomingMessage) {
  return (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  })()
}

async function sendScript(response: ServerResponse, descriptors: CursorDescriptors, script: CursorScript) {
  if (script.error) {
    response.writeHead(script.error.status, { "content-type": "application/json" })
      .end(JSON.stringify({ message: script.error.message }))
    return
  }
  const runSSE = descriptors.service("agent/v1/agent_service").methods.runSSE
  if (!runSSE) throw new Error("Cursor SDK lacks RunSSE descriptor")
  const message = runSSE.O
  response.writeHead(200, { "content-type": "application/connect+proto", "connect-protocol-version": "1" })
  let call = 0
  for (const step of script.steps) {
    if (step.kind === "text") {
      response.write(frame(0, message.fromJson({ interactionUpdate: { textDelta: { text: step.text } } }).toBinary()))
      continue
    }
    if (step.kind === "thinking") {
      response.write(frame(0, message.fromJson({ interactionUpdate: { thinkingDelta: { text: step.text } } }).toBinary()))
      response.write(frame(0, message.fromJson({ interactionUpdate: { thinkingCompleted: { thinkingDurationMs: step.durationMs } } }).toBinary()))
      continue
    }
    if (step.kind === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.ms))
      continue
    }
    const tool: CursorToolStep = step.kind === "read"
      ? { kind: "tool", tool: "readToolCall", args: { path: step.path }, result: { success: { path: step.path, content: step.result } } }
      : step
    const callId = `scripted-${step.kind}-${++call}`
    response.write(frame(0, message.fromJson({ interactionUpdate: {
      toolCallStarted: { callId, toolCall: { [tool.tool]: { args: tool.args } } },
    } }).toBinary()))
    if (tool.result === undefined) continue
    response.write(frame(0, message.fromJson({ interactionUpdate: {
      toolCallCompleted: { callId, toolCall: { [tool.tool]: { args: tool.args, result: tool.result } } },
    } }).toBinary()))
  }
  response.write(frame(0, message.fromJson({ interactionUpdate: { turnEnded: {
    inputTokens: String(script.usage?.inputTokens ?? 2),
    outputTokens: String(script.usage?.outputTokens ?? 3),
  } } }).toBinary()))
  response.end(frame(2, Buffer.from("{}")))
}

export async function startScriptedCursorBackend(port: number): Promise<ScriptedCursorBackend> {
  const descriptors = await loadCursorDescriptors()
  const requests: CursorRequest[] = []
  const runs: CursorRunRequest[] = []
  const scripts = new Map<string, CursorScript>()
  let defaultScript: string | undefined
  let catalog = DEFAULT_CATALOG
  const refused = new Map<string, number>()
  const refusedPaths = new Map<string, number>()
  const streams = new Map<string, PendingStream>()
  const selected = new Map<string, { name: string; script: CursorScript }>()
  const held = new Map<string, Set<string>>()
  const released = new Set<string>()
  const send = (id: string) => {
    const pending = streams.get(id)
    if (!pending?.script || !pending.name) return
    if (pending.script.hold && !released.has(pending.name)) {
      held.set(pending.name, (held.get(pending.name) ?? new Set<string>()).add(id))
      return
    }
    streams.delete(id)
    selected.delete(id)
    void sendScript(pending.response, descriptors, pending.script).catch((error: unknown) => {
      pending.response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  }
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = incoming.url ?? ""
      const body = await readBody(incoming)
      const [serviceName, methodName] = path.slice(1).split("/")
      const servicePath = SERVICE_PATHS[serviceName ?? ""]
      const method = servicePath
        ? Object.values(descriptors.service(servicePath).methods).find((item) => item.name === methodName)
        : undefined
      const contentType = incoming.headers["content-type"]
      const payload = contentType?.startsWith("application/connect+") ? body.subarray(5) : body
      const decoded = method && contentType !== "application/json"
        ? method.I.fromBinary(payload).toJson()
        : body.length ? JSON.parse(body.toString("utf8")) as unknown : undefined
      requests.push({ path, method: incoming.method ?? "", contentType, headers: incoming.headers, decoded })

      const refusedStatus = refusedPaths.get(path)
      if (refusedStatus !== undefined) {
        outgoing.writeHead(refusedStatus, { "content-type": "application/json" }).end(JSON.stringify({ message: `Scripted Cursor endpoint ${path} refused` }))
        return
      }

      if ((path.startsWith("/aiserver.v1.") || path.startsWith("/agent.v1."))
        && incoming.headers.authorization !== "Bearer scripted-access-token") {
        outgoing.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ message: "Cursor access token required" }))
        return
      }

      if (path === "/auth/exchange_user_api_key") {
        outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: "scripted-access-token" }))
      } else if (path === "/v1/models") {
        outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: catalog }))
      } else if (path === "/aiserver.v1.AnalyticsService/BootstrapStatsig") {
        outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({}))
      } else if (path === "/agent.v1.AgentService/RunSSE" && method) {
        const id = (decoded as { requestId?: string }).requestId
        if (!id) throw new Error("RunSSE omitted requestId")
        streams.set(id, { response: outgoing, ...selected.get(id) })
        setImmediate(() => send(id))
        incoming.on("close", () => {
          if (outgoing.destroyed) streams.delete(id)
        })
      } else if (path === "/aiserver.v1.BidiService/BidiAppend" && method) {
        const append = decoded as { data?: string; requestId?: { requestId?: string } }
        const id = append.requestId?.requestId
        if (!id || !append.data) throw new Error("BidiAppend omitted requestId or data")
        if (!selected.has(id)) {
          const run = descriptors.service("agent/v1/agent_service").methods.run
          if (!run) throw new Error("Cursor SDK lacks Run descriptor")
          const client = run.I
          const prompt = client.fromBinary(Buffer.from(append.data, "hex")).toJson()
          runs.push({ requestId: id, run: prompt })
          const name = scriptName(prompt) ?? defaultScript
          if (!name) throw new Error(`BidiAppend named no CURSOR_SCRIPT: ${JSON.stringify(prompt)}`)
          const script = scripts.get(name)
          if (!script) throw new Error(`Unknown Cursor script ${name}`)
          const status = refused.get(name)
          const selectedScript = status === undefined ? script : { ...script, error: { status, message: `Scripted Cursor run ${name} refused` } }
          selected.set(id, { name, script: selectedScript })
          const pending = streams.get(id)
          if (pending) {
            pending.script = selectedScript
            pending.name = name
          }
        }
        outgoing.writeHead(200, { "content-type": "application/proto" }).end(Buffer.from(method.O.fromJson({}).toBinary()))
        setImmediate(() => send(id))
      } else if (method) {
        outgoing.writeHead(200, { "content-type": "application/proto" }).end(Buffer.from(method.O.fromJson({}).toBinary()))
      } else {
        outgoing.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: `Unscripted Cursor endpoint ${path}` }))
      }
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ message: String(error) }))
    }
  })
  try {
    await listenOnLoopback(server, port)
  } catch (error) {
    await descriptors.close()
    throw error
  }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    runs,
    script(name, script) {
      if (scripts.has(name)) throw new Error(`Cursor script ${name} already exists`)
      scripts.set(name, script)
    },
    defaultScript(name) {
      if (!scripts.has(name)) throw new Error(`Unknown Cursor script ${name}`)
      defaultScript = name
    },
    models(items) { catalog = items },
    refuseRun(name, status) {
      if (!scripts.has(name)) throw new Error(`Unknown Cursor script ${name}`)
      refused.set(name, status)
    },
    refusePath(path, status) { refusedPaths.set(path, status) },
    release(name) {
      if (!scripts.has(name)) throw new Error(`Unknown Cursor script ${name}`)
      released.add(name)
      const ids = held.get(name) ?? new Set<string>()
      held.delete(name)
      for (const id of ids) send(id)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await descriptors.close()
    },
  }
}
