import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { ClaxedoApi } from "../harness/api"
import { startDaemon } from "../harness/daemon"
import { startEgressGuard } from "../harness/egress-guard"
import { releasePort, reservePort } from "../harness/ports"
import { startScriptedModelServer } from "../harness/scripted-model-server"
import { CONTRACT_DIST, ensureWorkspaceDist, HELPERS_DIST, LAUNCH_GATE_CHILD_DIST } from "../harness/workspace-dists"
import { measureTurn, summarizeTurns, timedStream, type TurnTimes } from "./latency-client"
import { intervals, ms, sleep, summarize, type Summary } from "./pipes"
import { startVendorProxy } from "./vendor-proxy"

const MODEL = { providerId: "pi", modelId: "openai/gpt-4.1" }
const REPLY = Array.from({ length: 40 }, (_, index) => `token${index} `).join("")

type LocalTurn = TurnTimes & { vendorRequest?: number; vendorFirstByte?: number; vendorDeltas: number[] }

function row(label: string, summary: Summary | undefined) {
  return summary ? `${label.padEnd(26)} p50 ${ms(summary.p50).padStart(6)}  mean ${ms(summary.mean).padStart(6)}  p95 ${ms(summary.p95).padStart(6)}  sd ${ms(summary.sd).padStart(5)}  n ${summary.n}` : `${label.padEnd(26)} -`
}

const { values } = parseArgs({ options: {
  turns: { type: "string", default: "6" },
  ttft: { type: "string", default: "600" },
  chunks: { type: "string", default: "40" },
  cadence: { type: "string", default: "25" },
  /** One way from the laptop to the vendor; a laptop in India reaches a US vendor in about 120 ms. */
  vendorMs: { type: "string", default: "120" },
  out: { type: "string" },
} })

for (const dist of [HELPERS_DIST, CONTRACT_DIST, LAUNCH_GATE_CHILD_DIST]) await ensureWorkspaceDist(dist)
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-local-latency-"))
const daemonPort = await reservePort()
const modelPort = await reservePort()
const guardPort = await reservePort()
const egress = await startEgressGuard(guardPort)
const scripted = await startScriptedModelServer({ port: modelPort, red: false })
scripted.setReplyDelayMs(Number(values.ttft))
scripted.setTextStreamPacing({ chunks: Number(values.chunks), delayMs: Number(values.cadence) })
const vendor = await startVendorProxy({ targetPort: modelPort, oneWayMs: Number(values.vendorMs) })
const daemon = await startDaemon({ dataDir, scripted: { ...scripted, url: vendor.url, v1Url: vendor.v1Url, port: vendor.port }, guardUrl: egress.url, port: daemonPort, red: false })
const turns: LocalTurn[] = []
try {
  const workspace = await daemon.makeWorkspace("latency")
  const api = new ClaxedoApi(daemon.url)
  const session = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model: MODEL })
  const directory = encodeURIComponent(workspace.directory)
  const stream = timedStream(fetch(`${daemon.url}/api/wr/events?directory=${directory}&sessionID=${encodeURIComponent(session.id)}`, { headers: { accept: "text/event-stream" } }))
  await stream.opened
  for (let index = 0; index < Number(values.turns); index++) {
    await sleep(1_000)
    const marker = `LATLOCAL${index}`
    scripted.scriptText({ marker, text: `${REPLY}${marker}` })
    const pressedAt = performance.now()
    const vendorBefore = vendor.requests.length
    const turn = await measureTurn({
      stream, sessionId: session.id,
      send: () => fetch(`${daemon.url}/session/${encodeURIComponent(session.id)}/prompt_async?directory=${directory}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: `Reply with the scripted text ending in ${marker}` }], messageID: `msg_${marker}`, model: { providerID: MODEL.providerId, modelID: MODEL.modelId } }),
      }),
    })
    const request = vendor.requests.slice(vendorBefore).find((candidate) => candidate.arrivedAt > pressedAt)
    turns.push({
      ...turn,
      ...(request ? { vendorRequest: request.arrivedAt - pressedAt, ...(request.firstByteAt ? { vendorFirstByte: request.firstByteAt - pressedAt } : {}) } : {}),
      vendorDeltas: request ? request.chunks.map((at) => at - pressedAt) : [],
    })
    process.stderr.write(`local turn ${index + 1}: accepted ${ms(turn.accepted)} first delta ${ms(turn.firstDelta)} (vendor ${ms(request?.firstByteAt === undefined ? undefined : request.firstByteAt - pressedAt)}) idle ${ms(turn.idle)}\n`)
  }
  stream.close()
} finally {
  await daemon.close()
  await vendor.close()
  await scripted.close()
  await egress.close()
  for (const port of [daemonPort, modelPort, guardPort]) releasePort(port)
  await fs.rm(dataDir, { recursive: true, force: true })
}
const summary = {
  ...summarizeTurns(turns),
  vendorRequest: summarize(turns.flatMap((turn) => turn.vendorRequest === undefined ? [] : [turn.vendorRequest])),
  vendorFirstByte: summarize(turns.flatMap((turn) => turn.vendorFirstByte === undefined ? [] : [turn.vendorFirstByte])),
  vendorInterDelta: summarize(turns.flatMap((turn) => intervals(turn.vendorDeltas))),
  clientJitter: summarize(turns.map((turn) => summarize(intervals(turn.deltas))?.sd ?? 0)),
}
console.log([
  `== local (daemon on loopback; vendor one way ${values.vendorMs} ms, ttft ${values.ttft} ms, ${values.chunks} chunks every ${values.cadence} ms)`,
  row("press -> accepted", summary.accepted),
  row("press -> vendor request", summary.vendorRequest),
  row("press -> vendor first byte", summary.vendorFirstByte),
  row("press -> client first delta", summary.firstDelta),
  row("inter-delta at vendor", summary.vendorInterDelta),
  row("inter-delta at client", summary.interDelta),
  row("jitter (sd) at client", summary.clientJitter),
  row("last delta -> idle", summary.lastDeltaToIdle),
  row("press -> idle", summary.idle),
].join("\n"))
if (values.out) {
  await fs.mkdir(values.out, { recursive: true })
  const file = path.join(values.out, `local-${new Date().toISOString().replaceAll(":", "-")}.json`)
  await fs.writeFile(file, JSON.stringify({ vendor: { ttftMs: Number(values.ttft), chunks: Number(values.chunks), cadenceMs: Number(values.cadence), oneWayMs: Number(values.vendorMs) }, turns, summary }, null, 2))
  console.log(`wrote ${file}`)
}
