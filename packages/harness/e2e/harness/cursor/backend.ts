import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { listenOnLoopback } from "../ports"
import { frame, openStream, sendScript } from "./backend-stream"
import { loadCursorDescriptors } from "./descriptors"

export type CursorToolStep = { kind: "tool"; tool: string; args: unknown; result?: unknown }

export type CursorUpdateStep = { kind: "update"; update: Record<string, unknown> }

export type CursorScript = {
  steps: Array<{ kind: "text"; text: string } | { kind: "thinking"; text: string; durationMs: number } | { kind: "read"; path: string; result: string } | { kind: "wait"; ms: number } | CursorToolStep | CursorUpdateStep>
  usage?: { inputTokens: number; outputTokens: number }
  error?: { status: number; message: string }
  hold?: boolean
  steer?: "delivered" | "rejected"
}

export type CursorSteer = { requestId: string; text: string }

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
  holdText(marker: string): () => void
  textHeld(marker: string): Promise<void>
  steers: CursorSteer[]
  close(): Promise<void>
}

const SERVICE_PATHS: Record<string, string> = {
  "agent.v1.AgentService": "agent/v1/agent_service",
  "aiserver.v1.DashboardService": "aiserver/v1/dashboard",
  "aiserver.v1.ServerConfigService": "aiserver/v1/server-config",
  "aiserver.v1.BidiService": "aiserver/v1/bidi",
  "aiserver.v1.AnalyticsService": "aiserver/v1/analytics",
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

type RunState = { response?: ServerResponse; name?: string; script?: CursorScript; marker?: string; sending: boolean }

type TextHold = { released: boolean; arrived: PromiseWithResolvers<void> }

function injectedContext(decoded: unknown): { injectionId: string; text: string } | undefined {
  const action = (decoded as { conversationAction?: { injectContextAction?: {
    injectionId?: string; userContext?: { userMessage?: { text?: string } } } } }).conversationAction?.injectContextAction
  return action?.injectionId ? { injectionId: action.injectionId, text: action.userContext?.userMessage?.text ?? "" } : undefined
}

export async function startScriptedCursorBackend(port: number): Promise<ScriptedCursorBackend> {
  const descriptors = await loadCursorDescriptors()
  const requests: CursorRequest[] = []
  const runs: CursorRunRequest[] = []
  const steers: CursorSteer[] = []
  const scripts = new Map<string, CursorScript>()
  let defaultScript: string | undefined
  let catalog = DEFAULT_CATALOG
  const refused = new Map<string, number>()
  const refusedPaths = new Map<string, number>()
  const byRequest = new Map<string, RunState>()
  const released = new Set<string>()
  const textHolds = new Map<string, TextHold>()
  const runSSE = descriptors.service("agent/v1/agent_service").methods.runSSE
  const run = descriptors.service("agent/v1/agent_service").methods.run
  if (!runSSE || !run) throw new Error("Cursor SDK lacks the Run or RunSSE descriptor")
  const state = (id: string) => byRequest.get(id) ?? byRequest.set(id, { sending: false }).get(id)!
  const holding = (current: RunState) => (current.script?.hold && !released.has(current.name ?? ""))
    || (current.marker !== undefined && !textHolds.get(current.marker)?.released)
  const send = (id: string) => {
    const current = byRequest.get(id)
    if (!current?.response || !current.script || current.sending || holding(current)) return
    current.sending = true
    const response = current.response
    void sendScript(response, descriptors, current.script).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  }
  const acknowledge = (id: string, injection: { injectionId: string; text: string }) => {
    const current = byRequest.get(id)
    steers.push({ requestId: id, text: injection.text })
    if (!current?.response || current.response.writableEnded) return
    const outcome = current.script?.steer ?? "delivered"
    openStream(current.response)
    current.response.write(frame(0, runSSE.O.fromJson({ interactionUpdate: {
      contextInjectionState: { injectionId: injection.injectionId, state: { [outcome]: {} } } } }).toBinary()))
    if (outcome === "delivered") current.response.write(frame(0, runSSE.O.fromJson({ interactionUpdate: {
      userMessageAppended: { userMessage: { text: injection.text, turnSteer: true } } } }).toBinary()))
  }
  const begin = (id: string, prompt: unknown) => {
    runs.push({ requestId: id, run: prompt })
    const name = scriptName(prompt) ?? defaultScript
    if (!name) throw new Error(`BidiAppend named no CURSOR_SCRIPT: ${JSON.stringify(prompt)}`)
    const script = scripts.get(name)
    if (!script) throw new Error(`Unknown Cursor script ${name}`)
    const status = refused.get(name)
    const marker = [...textHolds.keys()].find((held) => JSON.stringify(prompt).includes(held))
    if (marker) textHolds.get(marker)!.arrived.resolve()
    Object.assign(state(id), { name, script: status === undefined ? script : { ...script, error: { status, message: `Scripted Cursor run ${name} refused` } },
      ...(marker ? { marker } : {}) })
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
        state(id).response = outgoing
        setImmediate(() => send(id))
      } else if (path === "/aiserver.v1.BidiService/BidiAppend" && method) {
        const append = decoded as { data?: string; requestId?: { requestId?: string } }
        const id = append.requestId?.requestId
        if (!id || !append.data) throw new Error("BidiAppend omitted requestId or data")
        const message = run.I.fromBinary(Buffer.from(append.data, "hex")).toJson()
        const injection = injectedContext(message)
        if (!byRequest.get(id)?.script) begin(id, message)
        else if (injection) acknowledge(id, injection)
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
      for (const id of byRequest.keys()) send(id)
    },
    holdText(marker) {
      const hold: TextHold = { released: false, arrived: Promise.withResolvers<void>() }
      textHolds.set(marker, hold)
      return () => {
        hold.released = true
        for (const id of byRequest.keys()) send(id)
      }
    },
    textHeld(marker) {
      const hold = textHolds.get(marker)
      if (!hold) throw new Error(`No Cursor text hold for ${marker}`)
      return hold.arrived.promise
    },
    steers,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await descriptors.close()
    },
  }
}
