import { startNetworkProxy } from "../helpers/network-proxy"
import { startRealLocalServer } from "../helpers/real-local-server"
import { createServer } from "../../src/server/server"
import type { ServerEvent, SessionRef, SessionRow } from "../../src/server"

const PROBE_PORT = 46800
const STEP_TIMEOUT_MS = 30_000
const SERVER_NODE_MODULES = new URL("../../../claxedo-server/node_modules", import.meta.url).pathname

function daemonEnvironment() {
  process.env.NODE_PATH = [SERVER_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(":")
  const conditions = "--conditions=development"
  if (!process.env.NODE_OPTIONS?.includes(conditions)) process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, conditions].filter(Boolean).join(" ")
}

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string }
const checks: Check[] = []

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

async function until<T>(name: string, read: () => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${name}`)
}

async function attempt(name: string, run: () => Promise<string>) {
  try {
    record(name, true, await run())
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

function eventLog() {
  const events: ServerEvent[] = []
  return {
    events,
    push: (event: ServerEvent) => {
      events.push(event)
    },
    find: <T extends ServerEvent["type"]>(type: T, from: number, match?: (event: Extract<ServerEvent, { type: T }>) => boolean) =>
      events.slice(from).find((event): event is Extract<ServerEvent, { type: T }> => event.type === type && (match?.(event as Extract<ServerEvent, { type: T }>) ?? true)),
  }
}

function sameRef(a: SessionRef, b: SessionRef) {
  return a.sessionId === b.sessionId && a.placementId === b.placementId
}

function describe(events: readonly ServerEvent[]) {
  return events.map((event) => (event.type === "statusChanged" ? `statusChanged:${event.status.kind}` : event.type)).join(" ")
}

async function tapRawStream(url: string, sessionId: string) {
  const controller = new AbortController()
  const types: string[] = []
  const response = await fetch(`${url}/api/wr/events`, { headers: { Accept: "text/event-stream" }, signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    let buffer = ""
    while (true) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (next.done) return
      buffer += decoder.decode(next.value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
        if (!data || !data.includes(sessionId)) continue
        const frame = JSON.parse(data) as { payload?: { type?: string; properties?: { status?: { type?: string } } } }
        const type = frame.payload?.type ?? "?"
        types.push(type === "session.status" ? `session.status:${frame.payload?.properties?.status?.type}` : type)
      }
    }
  })()
  return { types, close: () => controller.abort() }
}

async function main() {
  daemonEnvironment()
  const daemon = await startRealLocalServer("adapter-smoke", { port: PROBE_PORT })
  const proxy = await startNetworkProxy(new URL(daemon.url))
  const workspace = await daemon.makeWorkspace("adapter")
  const server = createServer({ serverUrl: proxy.url, auth: { kind: "none" }, maxReconnectAttempts: 40 })
  const log = eventLog()
  server.subscribe(log.push)
  let row: SessionRow | undefined
  try {
    await server.ready
    await until("connection", () => (server.connection().kind === "connected" ? true : undefined))
    record("connect", true, `bootstrap read, streams connected, ${server.placements.list().length} placement(s)`)

    await attempt("projects: create and read back by id", async () => {
      const project = await server.projects.create({ source: { kind: "folder", path: workspace.directory } })
      const read = await server.queryClient.fetchQuery(server.queries.projects.byId(project.id))
      if (read.id !== project.id) throw new Error(`read back ${read.id}, created ${project.id}`)
      return `project ${project.id} "${project.name}"`
    })

    const placement = await until("placement for the workspace", () => server.placements.list().find((item) => item.path === workspace.directory))
    record("placements", true, `placement ${placement.id} kind=${placement.kind} project=${placement.projectId}`)

    await attempt("list: empty before create", async () => {
      const page = await server.sessions.list({ limit: 20 })
      return `${page.rows.length} row(s)`
    })

    await attempt("create", async () => {
      row = await server.sessions.create({ placementId: placement.id, harness: "pi", title: "Adapter smoke" })
      return `session ${row.ref.sessionId} "${row.title}"`
    })
    if (!row) throw new Error("no session")
    const ref = row.ref

    await attempt("snapshot: fresh session", async () => {
      const snapshot = await server.sessions.snapshot(ref)
      return `status=${snapshot.status.kind} entries=${snapshot.transcript.entries.length} requests=${snapshot.requests.length}`
    })

    await attempt("prompt: turn streams and settles", async () => {
      const from = log.events.length
      const tap = await tapRawStream(daemon.url, ref.sessionId)
      try {
        await server.sessions.prompt(ref, { clientRequestId: `msg_${crypto.randomUUID()}`, text: "Please reply with exactly this one token: ADAPTER_OK", attachments: [] })
        const part = await until("assistant text", () => log.find("partUpserted", from, (event) => sameRef(event.ref, ref) && JSON.stringify(event.part).includes("ADAPTER_OK")))
        const idle = await until("idle status", () => log.find("statusChanged", from, (event) => sameRef(event.ref, ref) && event.status.kind === "idle"), 15_000)
          .catch((error: Error) => { throw new Error(`${error.message}; adapter events: ${describe(log.events.slice(from))}; raw frames: ${tap.types.join(" ")}`) })
        const deltas = log.events.slice(from).filter((event) => event.type === "partDelta").length
        return `idle=${idle.status.kind} part=${part.part.type} deltas=${deltas} adapter events: ${describe(log.events.slice(from))}; raw frames: ${tap.types.join(" ")}`
      } finally {
        tap.close()
      }
    })

    await attempt("snapshot: after the turn", async () => {
      const snapshot = await server.sessions.snapshot(ref)
      const text = JSON.stringify(snapshot.transcript.entries)
      if (!text.includes("ADAPTER_OK")) throw new Error("latest-surface page lacks the reply")
      return `status=${snapshot.status.kind} entries=${snapshot.transcript.entries.length} older=${snapshot.transcript.olderCursor ? "yes" : "no"}`
    })

    await attempt("list: contains the session", async () => {
      const page = await server.sessions.list({ limit: 20 })
      const hit = page.rows.find((item) => sameRef(item.ref, ref))
      if (!hit) throw new Error(`${page.rows.length} row(s), none is ${ref.sessionId}`)
      return `title="${hit.title}" placement=${hit.ref.placementId}`
    })

    await attempt("stop: a held turn is cancelled", async () => {
      const release = daemon.scripted.holdTextReplies("HOLD_ME")
      try {
        const from = log.events.length
        await server.sessions.prompt(ref, { clientRequestId: `msg_${crypto.randomUUID()}`, text: "Please reply with exactly this one token: HOLD_ME", attachments: [] })
        await until("working status", () => log.find("statusChanged", from, (event) => sameRef(event.ref, ref) && event.status.kind === "working"))
        await server.sessions.stop(ref)
        const settled = await until("settled status", () => log.find("statusChanged", from + 1, (event) => sameRef(event.ref, ref) && event.status.kind !== "working"))
        return `status after stop=${settled.status.kind}`
      } finally {
        release()
      }
    })

    await attempt("resume: a frame sent while the socket was down is replayed by cursor", async () => {
      const from = log.events.length
      proxy.disconnect()
      await until("reconnecting", () => (server.connection().kind === "reconnecting" ? true : undefined))
      const patch = await fetch(`${daemon.url}/session/${encodeURIComponent(ref.sessionId)}?directory=${encodeURIComponent(workspace.directory)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed while away" }),
      })
      if (!patch.ok) throw new Error(`rename answered ${patch.status}`)
      proxy.reconnect()
      await until("connected again", () => (server.connection().kind === "connected" ? true : undefined))
      const replayed = await until("replayed rename", () => log.find("sessionUpserted", from, (event) => sameRef(event.row.ref, ref) && event.row.title === "Renamed while away"))
      const gap = log.find("streamGap", from)
      return `replayed "${replayed.row.title}" gap=${gap ? "yes" : "no"}`
    })

    await attempt("forced gap: a daemon restart answers the old cursor with a replay gap", async () => {
      const from = log.events.length
      await daemon.restart()
      const gap = await until("streamGap", () => log.find("streamGap", from), 60_000)
      await until("connected after restart", () => (server.connection().kind === "connected" ? true : undefined))
      return `gap=${gap.type} connection=${server.connection().kind}`
    })

    await attempt("archive and unarchive", async () => {
      await server.sessions.archive(ref, true)
      const archived = (await server.sessions.snapshot(ref)).row.archivedAt
      await server.sessions.archive(ref, false)
      const restored = (await server.sessions.snapshot(ref)).row.archivedAt
      return `archivedAt after archive=${archived ?? "unset"} after unarchive=${restored ?? "unset"}`
    })

    await attempt("remove", async () => {
      const from = log.events.length
      await server.sessions.remove(ref)
      await until("sessionRemoved", () => log.find("sessionRemoved", from, (event) => sameRef(event.ref, ref)))
      const page = await server.sessions.list({ limit: 20 })
      if (page.rows.some((item) => sameRef(item.ref, ref))) throw new Error("the list still holds the removed session")
      return "removed and gone from the list"
    })
  } finally {
    server.dispose()
    await proxy.close()
    await daemon.close()
  }
  const failed = checks.filter((check) => !check.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error("probe failed:", error)
  process.exit(1)
})
