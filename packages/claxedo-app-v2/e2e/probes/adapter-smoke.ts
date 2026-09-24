import net from "node:net"
import { acpScriptToken, SCRIPTED_ACP_HARNESS, startStack, type Stack } from "../harness"
import { appChoice, ensureAppBuilt } from "../harness/app"
import type { Workspace } from "../harness/daemon"
import type { ServerEvent } from "../../src/server/events"
import type { Placement } from "../../src/server/types"
import { createServer, type ServerHandle } from "../../src/server/server"

const STEP_TIMEOUT_MS = 30_000
const RESTART_TIMEOUT_MS = 60_000

type Proxy = { readonly url: string; readonly disconnect: () => void; readonly reconnect: () => void; readonly close: () => Promise<void> }
type Probe = { readonly stack: Stack; readonly proxy: Proxy; readonly server: ServerHandle; readonly log: EventLog; readonly workspace: Workspace }
type EventLog = ReturnType<typeof eventLog>

const results: { readonly name: string; readonly ok: boolean }[] = []

function startTcpProxy(target: URL): Promise<Proxy> {
  const sockets = new Set<net.Socket>()
  let accepting = true
  const server = net.createServer((client) => {
    if (!accepting) return client.destroy()
    const upstream = net.connect(Number(target.port), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => [client, upstream].forEach((end) => end.destroy()))
    }
    client.pipe(upstream).pipe(client)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        disconnect: () => {
          accepting = false
          for (const socket of sockets) socket.destroy()
        },
        reconnect: () => {
          accepting = true
        },
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

function describeEvent(event: ServerEvent) {
  if (event.type !== "statusChanged") return event.type
  return event.status.kind === "failed" ? `statusChanged:failed(${event.status.error.message})` : `statusChanged:${event.status.kind}`
}

function describe(events: readonly ServerEvent[]) {
  return events.map(describeEvent).join(" ")
}

function eventLog(server: ServerHandle) {
  const seen: ServerEvent[] = []
  const waiters = new Set<(event: ServerEvent) => void>()
  server.subscribe((event) => {
    seen.push(event)
    for (const waiter of waiters) waiter(event)
  })
  const next = <T extends ServerEvent>(name: string, from: number, match: (event: ServerEvent) => event is T, timeoutMs = STEP_TIMEOUT_MS) =>
    new Promise<T>((resolve, reject) => {
      const earlier = seen.slice(from).find(match)
      if (earlier) return resolve(earlier)
      const waiter = (event: ServerEvent) => {
        if (!match(event)) return
        waiters.delete(waiter)
        clearTimeout(timer)
        resolve(event)
      }
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`timed out waiting for ${name}; saw: ${describe(seen.slice(from))}`))
      }, timeoutMs)
      waiters.add(waiter)
    })
  return { seen, next, mark: () => seen.length }
}

async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (let value = read(); ; value = read()) {
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function check(name: string, run: () => Promise<string>) {
  try {
    const detail = await run()
    results.push({ name, ok: true })
    console.log(`PASS ${name}: ${detail}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const isStatus = (sessionId: string, kinds: readonly string[]) => (event: ServerEvent): event is Extract<ServerEvent, { type: "statusChanged" }> =>
  event.type === "statusChanged" && event.ref.sessionId === sessionId && kinds.includes(event.status.kind)

async function connectAndPlace(probe: Probe): Promise<Placement> {
  const { server, workspace } = probe
  await check("connect", async () => {
    await server.ready
    await waitFor("connected", () => (server.connection().kind === "connected" ? true : undefined))
    const harnesses = server.capabilities()?.harnesses.map((harness) => `${harness.id}:${harness.models.length}`).join(",")
    return `connected, ${server.placements.list().length} placement(s), harnesses ${harnesses}`
  })
  await check("projects: create from a folder and read back by id", async () => {
    const project = await server.projects.create({ source: { kind: "folder", path: workspace.directory } })
    const read = await server.queryClient.fetchQuery(server.queries.projects.byId(project.id))
    if (read.id !== project.id) throw new Error(`read back ${read.id}, created ${project.id}`)
    return `project ${project.id} "${project.name}"`
  })
  const placement = await waitFor("placement", () => server.placements.list().find((item) => item.path === workspace.directory))
  console.log(`PASS placements: ${placement.id} kind=${placement.kind} project=${placement.projectId}`)
  await check("files and git queries", async () => {
    const found = await server.queryClient.fetchQuery(server.queries.files.search(placement.id, "README"))
    const git = await server.queryClient.fetchQuery(server.queries.git.status(placement.id))
    return `search README → ${found.join(",")}; git branch=${git.branch ?? "?"} staged=${git.staged.length} unstaged=${git.unstaged.length}`
  })
  await check("terminals: create, list, remove", async () => {
    const terminal = await server.terminals.create({ placementId: placement.id, title: "Probe", createRequestId: crypto.randomUUID() })
    const listed = await server.terminals.list(placement.id)
    await server.terminals.remove(placement.id, terminal.id)
    return `terminal ${terminal.id} listed=${listed.some((item) => item.id === terminal.id)}`
  })
  return placement
}

async function turnChecks(probe: Probe, placement: Placement) {
  const { server, log, stack } = probe
  await check("harness options: pi", async () => {
    const options = await server.queryClient.fetchQuery(server.queries.harnesses.options(placement.id, "pi"))
    const connected = options.models.filter((item) => item.connected).length
    return `${options.models.length} model(s), ${connected} connected, current=${options.current?.modelId}, efforts=${options.efforts.join(",")}`
  })
  const row = await server.sessions.create({ placementId: placement.id, harness: SCRIPTED_ACP_HARNESS.id, title: "Adapter smoke" })
  const ref = row.ref
  console.log(`PASS create: session ${ref.sessionId} "${row.title}" on ${SCRIPTED_ACP_HARNESS.id}`)
  await check("snapshot: fresh session", async () => {
    const snapshot = await server.sessions.snapshot(ref)
    return `status=${snapshot.status.kind} entries=${snapshot.transcript.entries.length} goal actions=[${snapshot.goal.actions.join(",")}]`
  })
  await check("prompt: the turn streams and settles", async () => {
    await stack.acp.write("reply", { steps: [{ kind: "text", text: "ADAPTER_OK streamed in four pieces", chunks: 4 }] })
    const from = log.mark()
    await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: `Answer. ${acpScriptToken("reply")}`, attachments: [] })
    await log.next("idle", from, isStatus(ref.sessionId, ["idle"]))
    const text = log.seen.slice(from).filter((event) => event.type === "partUpserted" || event.type === "partDelta").map((event) => JSON.stringify(event)).join("")
    if (!text.includes("ADAPTER_OK")) throw new Error(`no part carried the reply; saw: ${describe(log.seen.slice(from))}`)
    return describe(log.seen.slice(from))
  })
  await check("snapshot and list after the turn", async () => {
    const snapshot = await server.sessions.snapshot(ref)
    if (!JSON.stringify(snapshot.transcript.entries).includes("ADAPTER_OK")) throw new Error("the latest-surface page lacks the reply")
    const page = await server.sessions.list({ limit: 20 })
    const hit = page.rows.find((item) => item.ref.sessionId === ref.sessionId)
    if (!hit) throw new Error(`${page.rows.length} row(s), none is ${ref.sessionId}`)
    return `entries=${snapshot.transcript.entries.length} list row "${hit.title}" placement=${hit.ref.placementId}`
  })
  await check("stop: a held turn is reported working, then cancelled", async () => {
    await stack.acp.write("held", { steps: [{ kind: "hold", name: "held" }, { kind: "text", text: "too late" }] })
    try {
      const from = log.mark()
      await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: `Wait. ${acpScriptToken("held")}`, attachments: [] })
      await log.next("working", from, isStatus(ref.sessionId, ["working"]))
      const working = log.mark()
      const read = await server.sessions.statuses()
      const reported = read.reports.find((report) => report.ref.sessionId === ref.sessionId)?.status.kind
      const queued = await server.sessions.queue(ref)
      await server.sessions.stop(ref)
      const settled = await log.next("settled", working, isStatus(ref.sessionId, ["idle", "failed"]))
      return `statuses: ${reported} (failures=${read.failures.length}), queued=${queued.length}, after stop=${settled.status.kind}`
    } finally {
      await stack.acp.release("held")
    }
  })
  return ref
}

async function streamChecks(probe: Probe, sessionId: string) {
  const { server, log, proxy, stack, workspace } = probe
  await check("resume: a frame sent while the stream was down is replayed by cursor", async () => {
    const from = log.mark()
    proxy.disconnect()
    await waitFor("reconnecting", () => (server.connection().kind === "reconnecting" ? true : undefined))
    const renamed = await fetch(`${stack.url}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(workspace.directory)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed while away" }),
    })
    if (!renamed.ok) throw new Error(`rename answered ${renamed.status}`)
    proxy.reconnect()
    const replayed = await log.next("replayed rename", from, (event): event is Extract<ServerEvent, { type: "sessionUpserted" }> =>
      event.type === "sessionUpserted" && event.row.ref.sessionId === sessionId && event.row.title === "Renamed while away")
    return `replayed "${replayed.row.title}", gap=${log.seen.slice(from).some((event) => event.type === "streamGap")}`
  })
  await check("forced gap: a daemon restart answers the old cursor with a replay gap", async () => {
    const from = log.mark()
    await stack.daemon.restart()
    await log.next("streamGap", from, (event): event is ServerEvent => event.type === "streamGap", RESTART_TIMEOUT_MS)
    await waitFor("connected after restart", () => (server.connection().kind === "connected" ? true : undefined), RESTART_TIMEOUT_MS)
    return `streamGap received, connection=${server.connection().kind}`
  })
}

async function cleanupChecks(probe: Probe, ref: Parameters<ServerHandle["sessions"]["remove"]>[0]) {
  const { server, log } = probe
  await check("archive and unarchive", async () => {
    await server.sessions.archive(ref, true)
    const archived = (await server.sessions.snapshot(ref)).row.archivedAt
    await server.sessions.archive(ref, false)
    const restored = (await server.sessions.snapshot(ref)).row.archivedAt
    if (!archived || restored) throw new Error(`archivedAt after archive=${archived} after unarchive=${restored}`)
    return `archivedAt=${archived}, then unset`
  })
  await check("remove", async () => {
    const from = log.mark()
    await server.sessions.remove(ref)
    await log.next("sessionRemoved", from, (event): event is ServerEvent => event.type === "sessionRemoved" && event.ref.sessionId === ref.sessionId)
    const page = await server.sessions.list({ limit: 20 })
    if (page.rows.some((item) => item.ref.sessionId === ref.sessionId)) throw new Error("the list still holds the removed session")
    return "removed, and gone from the list"
  })
}

async function main() {
  await ensureAppBuilt(appChoice(), { serverUrl: "http://127.0.0.1:46800" })
  const stack = await startStack({ label: "adapter-smoke" })
  const proxy = await startTcpProxy(new URL(stack.url))
  const server = createServer({ serverUrl: proxy.url, auth: { kind: "none" }, maxReconnectAttempts: 40 })
  const probe: Probe = { stack, proxy, server, log: eventLog(server), workspace: await stack.daemon.makeWorkspace("adapter") }
  try {
    const placement = await connectAndPlace(probe)
    const ref = await turnChecks(probe, placement)
    await streamChecks(probe, ref.sessionId)
    await cleanupChecks(probe, ref)
  } finally {
    server.dispose()
    await proxy.close()
    await stack.close()
  }
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
