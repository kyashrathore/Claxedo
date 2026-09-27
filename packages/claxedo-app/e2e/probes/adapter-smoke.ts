import { acpScriptToken, SCRIPTED_ACP_HARNESS, startStack } from "../harness"
import { ensureAppBuilt } from "../harness/app"
import type { ServerEvent } from "../../src/server/events"
import type { Placement } from "../../src/server/types"
import { codeHostConnections } from "../../src/server/integrations"
import { createServer, type ServerHandle } from "../../src/server/server"
import { check, describe, eventLog, isStatus, RESTART_TIMEOUT_MS, results, surfaceOf, waitFor, type Probe } from "./probe-support"
import { startTcpProxy } from "./tcp-proxy"

async function connectAndPlace(probe: Probe): Promise<Placement> {
  const { server, workspace } = probe
  await check("connect", async () => {
    await server.ready
    await waitFor("connected", () => (server.connection().kind === "connected" ? true : undefined))
    const capabilities = server.capabilities()
    const harnesses = capabilities?.harnesses.map((harness) => `${harness.id}:${harness.available ? "ready" : harness.unavailableReason}`).join(", ")
    const features = Object.entries(capabilities?.features ?? {}).filter(([, on]) => on).map(([name]) => name).join(",")
    return `connected, this machine=${capabilities?.thisMachine?.id}, harnesses ${harnesses}, features ${features}`
  })
  await check("fetched-data queries", async () => {
    const fetch = server.queryClient.fetchQuery.bind(server.queryClient)
    const [machines, hosts, accounts, catalog, cloud] = await Promise.all([
      fetch(server.queries.machines.list()),
      fetch(server.queries.integrations.catalog()),
      fetch(server.queries.accounts.list()),
      fetch(server.queries.marketplace.catalog()),
      fetch(server.queries.cloud.list()),
    ])
    return `machines=${machines.map((machine) => machine.name).join(",")} codeHosts=${codeHostConnections(hosts).length} accounts=${accounts.map((account) => account.providerId).join(",")} plugins=${catalog.candidates.length} cloud=${cloud.length}`
  })
  await check("plugin host calls", async () => {
    const health = await server.request("/api/claxedo/health")
    const removal = await server.livePlugins.remove("probe-missing").then(() => "removed", (error: { class?: string }) => error.class)
    if (!health.ok || removal !== "not_found") throw new Error(`health=${health.status} removal=${removal}`)
    return `request health=${health.status}, removing an unknown live plugin → ${removal}`
  })
  const placement = await waitFor("placement", () => server.placements.list().find((item) => item.path === workspace.directory))
  console.log(`PASS placements: ${placement.id} kind=${placement.kind} project=${placement.projectId}`)
  await check("projects: the workspace's project reads back by id", async () => {
    const read = await server.queryClient.fetchQuery(server.queries.projects.byId(placement.projectId))
    if (read.id !== placement.projectId) throw new Error(`read back ${read.id}, placed under ${placement.projectId}`)
    return `project ${read.id} "${read.name}"`
  })
  await check("files and git queries", async () => {
    const found = await server.queryClient.fetchQuery(server.queries.files.search(placement.id, "README", "files"))
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
    const models = options.models?.choices ?? []
    const connected = models.filter((item) => item.connected !== false).length
    const logins = await server.queryClient.fetchQuery(server.queries.accounts.machineLogins())
    const signedIn = logins.map((login) => `${login.harness}:${login.state === "signed_in" ? "in" : "out"}`).join(",")
    return `${models.length} model(s), ${connected} connected, current=${options.models?.current}, efforts=${(options.thoughtLevels?.choices ?? []).map((level) => level.id).join(",")}; logins ${signedIn}`
  })
  await check("provider catalogs: the opencode summary, then one provider's detail", async () => {
    const summary = await server.queryClient.fetchQuery(server.queries.providerCatalogs.catalog("opencode"))
    const connected = new Set(summary.connected)
    const models = (id: string) => Object.keys(summary.all.find((item) => item.id === id)?.models ?? {}).length
    if (summary.all.some((item) => !connected.has(item.id) && models(item.id) > 0)) throw new Error("the summary carried models for a provider that is not connected")
    const empty = summary.all.find((item) => !connected.has(item.id))
    if (empty) await server.providerCatalogs.loadDetail("opencode", empty.id)
    const merged = server.queryClient.getQueryData<typeof summary>(server.queries.providerCatalogs.catalog("opencode").queryKey)
    const detail = empty ? Object.keys(merged?.all.find((item) => item.id === empty.id)?.models ?? {}).length : 0
    if (empty && detail === 0) throw new Error(`the detail read left ${empty.id} without models`)
    return `${summary.all.length} provider(s), connected ${summary.connected.join(",")}; ${empty ? `${empty.id} detail → ${detail} model(s)` : "none left empty"}`
  })
  const row = await server.sessions.create({ placementId: placement.id, harness: SCRIPTED_ACP_HARNESS.id, title: "Adapter smoke" })
  const ref = row.ref
  console.log(`PASS create: session ${ref.sessionId} "${row.title}" on ${SCRIPTED_ACP_HARNESS.id}`)
  await check("session reads: fresh session", async () => {
    const reads = server.sessions.read(ref)
    const [surface, status, goal] = await Promise.all([reads.surface, reads.status, reads.goal, reads.requests, reads.todos])
    return `status=${status.kind} entries=${surface.transcript.entries.length} goal actions=[${goal.actions.join(",")}]`
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
  await check("session surface and list after the turn", async () => {
    const snapshot = await surfaceOf(server, ref)
    if (!JSON.stringify(snapshot.transcript.entries).includes("ADAPTER_OK")) throw new Error("the latest-surface page lacks the reply")
    const page = await server.sessions.list({ projectId: ref.projectId, limit: 20 })
    const hit = page.rows.find((item) => item.ref.sessionId === ref.sessionId)
    if (!hit) throw new Error(`${page.rows.length} row(s), none is ${ref.sessionId}`)
    return `entries=${snapshot.transcript.entries.length} list row "${hit.title}" placement=${hit.ref.placementId}`
  })
  await check("subagents: a delegated child is listed and readable", async () => {
    await stack.acp.write("delegate", { steps: [{ kind: "subagent", name: "researcher", task: "Find it", steps: [{ kind: "text", text: "Found it" }] }, { kind: "text", text: "Done" }] })
    const from = log.mark()
    await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: `Delegate. ${acpScriptToken("delegate")}`, attachments: [] })
    await log.next("subagentUpdated", from, (event): event is ServerEvent => event.type === "subagentUpdated" && event.ref.sessionId === ref.sessionId)
    await log.next("idle", from, isStatus(ref.sessionId, ["idle"]))
    const child = (await server.sessions.read(ref).subagents).find((subagent) => subagent.childSessionId)
    if (!child?.childSessionId) throw new Error("no subagent names a child session")
    const snapshot = await surfaceOf(server, { ...ref, sessionId: child.childSessionId as typeof ref.sessionId })
    return `${child.subagentKey} status=${child.status} child entries=${snapshot.transcript.entries.length}`
  })
  await check("stop: a held turn is reported working, then cancelled", async () => {
    await stack.acp.write("held", { steps: [{ kind: "hold", name: "held" }, { kind: "text", text: "too late" }] })
    try {
      const from = log.mark()
      await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: `Wait. ${acpScriptToken("held")}`, attachments: [] })
      await log.next("working", from, isStatus(ref.sessionId, ["working"]))
      const working = log.mark()
      const listed = await server.sessions.list({ projectId: ref.projectId, limit: 20 })
      const reported = listed.statuses.get(ref.sessionId)?.status.kind
      const delivery = await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: "Later.", attachments: [], delivery: "queue" })
      const queued = await server.sessions.queue(ref)
      const first = queued[0]
      if (delivery !== "queue" || !first) throw new Error(`delivery=${delivery}, queued=${queued.length}`)
      const cancelled = await server.sessions.controlQueued(ref, first.seq, "cancel")
      const left = await server.sessions.queue(ref)
      await server.sessions.stop(ref)
      const settled = await log.next("settled", working, isStatus(ref.sessionId, ["idle", "failed"]))
      return `listed status: ${reported}, delivery=${delivery}, queued=${queued.length}, cancel ok=${cancelled.ok}, left=${left.length}, after stop=${settled.status.kind}`
    } finally {
      await stack.acp.release("held")
    }
  })
  await check("failed: a failed turn stays failed across a list read of one request", async () => {
    await stack.acp.write("failing", { steps: [{ kind: "error", message: "Scripted turn failure" }] })
    const from = log.mark()
    await server.sessions.prompt(ref, { clientRequestId: crypto.randomUUID(), text: `Fail. ${acpScriptToken("failing")}`, attachments: [] })
    await log.next("failed", from, isStatus(ref.sessionId, ["failed"]))
    const paths: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname)
      return original(input, init)
    }) as typeof fetch
    const read = await server.sessions.list({ projectId: ref.projectId, limit: 20 }).finally(() => (globalThis.fetch = original))
    const reported = read.statuses.get(ref.sessionId)?.status.kind
    if (reported !== "failed" || paths.join(",") !== "/api/claxedo/session-list") throw new Error(`reported=${reported}, reads=${paths.join(",")}`)
    return `reported=${reported}, reads=${paths.sort().join(",")}`
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
    const archived = (await surfaceOf(server, ref)).row.archivedAt
    await server.sessions.archive(ref, false)
    const restored = (await surfaceOf(server, ref)).row.archivedAt
    if (!archived || restored) throw new Error(`archivedAt after archive=${archived} after unarchive=${restored}`)
    return `archivedAt=${archived}, then unset`
  })
  await check("remove", async () => {
    const from = log.mark()
    await server.sessions.remove(ref)
    await log.next("sessionRemoved", from, (event): event is ServerEvent => event.type === "sessionRemoved" && event.ref.sessionId === ref.sessionId)
    const page = await server.sessions.list({ projectId: ref.projectId, limit: 20 })
    if (page.rows.some((item) => item.ref.sessionId === ref.sessionId)) throw new Error("the list still holds the removed session")
    return "removed, and gone from the list"
  })
}

async function main() {
  await ensureAppBuilt({ serverUrl: "http://127.0.0.1:46800" })
  const stack = await startStack({ label: "adapter-smoke" })
  const proxy = await startTcpProxy(new URL(stack.url))
  const workspace = await stack.daemon.makeWorkspace("adapter")
  const server = createServer({ serverUrl: proxy.url, auth: { kind: "none" } })
  const probe: Probe = { stack, proxy, server, log: eventLog(server), workspace }
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
