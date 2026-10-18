import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { startScriptedModelServer, type ScriptedModelServer } from "../../../harness/e2e/harness/scripted-model-server"
import { releasePort, reservePort } from "../../../harness/e2e/harness/ports"
import { measureTurn, summarizeTurns, timedStream, type TurnTimes } from "../../../harness/e2e/perf/latency-client"
import { intervals, ms, sleep, summarize, summaryRow, type Summary } from "../../../harness/e2e/perf/pipes"
import { startVendorProxy, type VendorProxy } from "../../../harness/e2e/perf/vendor-proxy"
import { bootTopology, bundleScripts, STAGING_LINKS, type Links, type Scripts, type Topology } from "./topology"

const MODEL = { providerID: "pi", modelID: "openai/gpt-4.1" }
const SECRET = "pi-latency-secret"
const REPLY = Array.from({ length: 40 }, (_, index) => `token${index} `).join("")

type Scenario = { name: string; links: Links; relayCacheTtlMs?: number; path: "relay" | "direct"; coldObject?: boolean; pauseMs: number }

const SCENARIOS: Record<string, Scenario> = {
  "relay-warm": { name: "relay-warm", links: STAGING_LINKS, path: "relay", pauseMs: 1_000 },
  "relay-cold-cache": { name: "relay-cold-cache", links: STAGING_LINKS, relayCacheTtlMs: 1, path: "relay", pauseMs: 1_000 },
  "direct": { name: "direct", links: STAGING_LINKS, path: "direct", pauseMs: 1_000 },
  "cold-object": { name: "cold-object", links: STAGING_LINKS, path: "relay", coldObject: true, pauseMs: 1_000 },
  "cp-slow": { name: "cp-slow", links: { ...STAGING_LINKS, cpMs: 400 }, path: "relay", pauseMs: 1_000 },
  "no-links": { name: "no-links", links: { clientEdgeMs: 0, roomDoMs: 0, doCpMs: 0, cpMs: 0, vendorMs: 0 }, path: "relay", pauseMs: 1_000 },
}

type HopTimes = TurnTimes & {
  roomPromptSent?: number
  objectPromptAnswered?: number
  vendorRequest?: number
  vendorFirstByte?: number
  vendorDeltas: number[]
  objectDeltas: number[]
  /** The control-plane calls the object made during the turn, by action, as milliseconds after the press when each was answered. */
  controlPlane: Array<{ action: string; at: number; ms: number }>
}

type ScenarioResult = {
  scenario: Scenario
  turns: HopTimes[]
  summary: ReturnType<typeof summarizeTurns> & {
    roomPromptSent: Summary | undefined
    objectPromptAnswered: Summary | undefined
    vendorRequest: Summary | undefined
    vendorFirstByte: Summary | undefined
    objectFirstDelta: Summary | undefined
    vendorInterDelta: Summary | undefined
    objectInterDelta: Summary | undefined
    objectJitter: Summary | undefined
    clientJitter: Summary | undefined
  }
  cpCalls: Record<string, number>
  resolverCalls: Record<string, number>
  streamOpen: Summary | undefined
}

function count(paths: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of paths) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

function deltasInChunks(chunks: ReadonlyArray<{ at: number; text: string }>, after: number, before: number): number[] {
  const times: number[] = []
  for (const chunk of chunks) {
    if (chunk.at <= after || chunk.at > before) continue
    for (const _ of chunk.text.matchAll(/"message\.part\.delta"/g)) times.push(chunk.at)
  }
  return times
}

async function createSession(topology: Topology, send: Topology["relay"]) {
  const response = await send(`/session/${topology.root}`, {
    method: "POST", headers: { "x-claxedo-session-registration-operation": `op_${topology.root}` },
    body: JSON.stringify({ harness: { id: "pi", access: "native" }, model: { providerID: MODEL.providerID, id: MODEL.modelID } }),
  })
  if (!response.ok) throw new Error(`Session create answered ${response.status}: ${await response.text()}\n${topology.stderr()}`)
}

async function runScenario(scenario: Scenario, input: { scripts: Scripts; model: ScriptedModelServer; vendor: VendorProxy; turns: number }): Promise<ScenarioResult> {
  const persist = await mkdtemp(path.join(tmpdir(), "pi-latency-do-"))
  const boot = (world?: Topology["world"]) => bootTopology({ scripts: input.scripts, persist, root: "ses_latency", links: scenario.links, vendor: { url: input.vendor.url, secret: SECRET },
    ...(scenario.relayCacheTtlMs === undefined ? {} : { relayCacheTtlMs: scenario.relayCacheTtlMs }), ...(world ? { world } : {}) })
  let topology = await boot()
  const send = () => scenario.path === "relay" ? topology.relay : topology.direct
  const turns: HopTimes[] = []
  const cpCalls: string[] = []
  const resolverCalls: string[] = []
  /** How long each event stream took to open, from the press to its first bytes; on a fresh object this holds the object's start. */
  const streamOpens: number[] = []
  try {
    await createSession(topology, send())
    const openStream = async () => {
      const startedAt = performance.now()
      const opened = timedStream(send()(`/api/wr/events?sessionID=${topology.root}`))
      await opened.opened
      streamOpens.push(performance.now() - startedAt)
      return opened
    }
    let stream = await openStream()
    for (let index = 0; index < input.turns; index++) {
      if (scenario.coldObject && index > 0) {
        stream.close()
        cpCalls.push(...topology.cpCalls.map((call) => call.path))
        resolverCalls.push(...topology.resolverCalls.map((call) => call.path))
        await topology.dispose()
        topology = await boot(topology.world)
        stream = await openStream()
      }
      await sleep(scenario.pauseMs)
      const marker = `LAT${scenario.name.replaceAll("-", "").toUpperCase()}${index}`
      input.model.scriptText({ marker, text: `${REPLY}${marker}` })
      const pressedAt = performance.now()
      const vendorBefore = input.vendor.requests.length
      const turn = await measureTurn({
        stream, sessionId: topology.root,
        send: () => send()(`/session/${topology.root}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: `Reply with the scripted text ending in ${marker}` }], messageID: `msg_${marker}`, model: MODEL }) }),
      })
      const vendor = input.vendor.requests.slice(vendorBefore).find((request) => request.arrivedAt > pressedAt)
      const prompt = topology.pipe.find((record) => record.path.endsWith("/prompt_async") && record.arrivedAt > pressedAt)
      const events = topology.pipe.find((record) => record.path.endsWith("/api/wr/events"))
      const objectDeltas = events ? deltasInChunks(events.chunks, pressedAt, pressedAt + turn.idle).map((at) => at - pressedAt) : []
      turns.push({
        ...turn,
        ...(prompt ? { roomPromptSent: prompt.arrivedAt - pressedAt, ...(prompt.answeredAt ? { objectPromptAnswered: prompt.answeredAt - pressedAt } : {}) } : {}),
        ...(vendor ? { vendorRequest: vendor.arrivedAt - pressedAt, ...(vendor.firstByteAt ? { vendorFirstByte: vendor.firstByteAt - pressedAt } : {}) } : {}),
        vendorDeltas: vendor ? vendor.chunks.map((at) => at - pressedAt) : [],
        objectDeltas,
        controlPlane: topology.cpCalls.filter((call) => call.at > pressedAt && call.at <= pressedAt + turn.idle + 500).map((call) => ({ action: call.path, at: call.at + call.ms - pressedAt, ms: call.ms })),
      })
      if (index === 0) process.stderr.write(`  control plane: ${turns[0].controlPlane.map((call) => `${call.action}@${ms(call.at)}`).join(" ")}\n`)
      process.stderr.write(`${scenario.name} turn ${index + 1}: accepted ${ms(turn.accepted)} first delta ${ms(turn.firstDelta)} (object ${ms(objectDeltas[0])}, vendor ${ms(vendor?.firstByteAt === undefined ? undefined : vendor.firstByteAt - pressedAt)}) idle ${ms(turn.idle)}\n`)
    }
    stream.close()
    cpCalls.push(...topology.cpCalls.map((call) => call.path))
    resolverCalls.push(...topology.resolverCalls.map((call) => call.path))
  } finally {
    await topology.dispose()
    await rm(persist, { recursive: true, force: true })
  }
  const jitter = (series: readonly number[][]) => summarize(series.map((times) => summarize(intervals(times))?.sd ?? 0))
  return {
    scenario, turns,
    summary: {
      ...summarizeTurns(turns),
      roomPromptSent: summarize(turns.flatMap((turn) => turn.roomPromptSent === undefined ? [] : [turn.roomPromptSent])),
      objectPromptAnswered: summarize(turns.flatMap((turn) => turn.objectPromptAnswered === undefined ? [] : [turn.objectPromptAnswered])),
      vendorRequest: summarize(turns.flatMap((turn) => turn.vendorRequest === undefined ? [] : [turn.vendorRequest])),
      vendorFirstByte: summarize(turns.flatMap((turn) => turn.vendorFirstByte === undefined ? [] : [turn.vendorFirstByte])),
      objectFirstDelta: summarize(turns.flatMap((turn) => turn.objectDeltas.length ? [turn.objectDeltas[0]] : [])),
      vendorInterDelta: summarize(turns.flatMap((turn) => intervals(turn.vendorDeltas))),
      objectInterDelta: summarize(turns.flatMap((turn) => intervals(turn.objectDeltas))),
      objectJitter: jitter(turns.map((turn) => turn.objectDeltas)),
      clientJitter: jitter(turns.map((turn) => turn.deltas)),
    },
    cpCalls: count(cpCalls),
    resolverCalls: count(resolverCalls),
    streamOpen: summarize(streamOpens),
  }
}

function report(result: ScenarioResult): string {
  const { summary } = result
  return [
    `== ${result.scenario.name} (${result.scenario.path}; links ${JSON.stringify(result.scenario.links)}${result.scenario.relayCacheTtlMs === undefined ? "" : `; relay cache ${result.scenario.relayCacheTtlMs} ms`}${result.scenario.coldObject ? "; fresh object per turn" : ""})`,
    summaryRow("press -> accepted", summary.accepted),
    summaryRow("press -> room sent prompt", summary.roomPromptSent),
    summaryRow("press -> object answered", summary.objectPromptAnswered),
    summaryRow("press -> vendor request", summary.vendorRequest),
    summaryRow("press -> vendor first byte", summary.vendorFirstByte),
    summaryRow("press -> object first delta", summary.objectFirstDelta),
    summaryRow("press -> client first delta", summary.firstDelta),
    summaryRow("inter-delta at vendor", summary.vendorInterDelta),
    summaryRow("inter-delta at object", summary.objectInterDelta),
    summaryRow("inter-delta at client", summary.interDelta),
    summaryRow("jitter (sd) at object", summary.objectJitter),
    summaryRow("jitter (sd) at client", summary.clientJitter),
    summaryRow("last delta -> idle", summary.lastDeltaToIdle),
    summaryRow("press -> idle", summary.idle),
    summaryRow("event stream open", result.streamOpen),
    `control-plane calls ${JSON.stringify(result.cpCalls)}`,
    `relay resolver calls ${JSON.stringify(result.resolverCalls)}`,
  ].join("\n")
}

const { values } = parseArgs({ options: {
  scenario: { type: "string", default: "relay-warm" },
  turns: { type: "string", default: "6" },
  ttft: { type: "string", default: "600" },
  chunks: { type: "string", default: "40" },
  cadence: { type: "string", default: "25" },
  out: { type: "string" },
} })
const names = values.scenario.split(",").map((name) => name.trim()).filter(Boolean)
for (const name of names) if (!SCENARIOS[name]) throw new Error(`Unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`)
const modelPort = await reservePort()
const model = await startScriptedModelServer({ port: modelPort, red: false })
model.setReplyDelayMs(Number(values.ttft))
model.setTextStreamPacing({ chunks: Number(values.chunks), delayMs: Number(values.cadence) })
const scripts = await bundleScripts()
const results: ScenarioResult[] = []
try {
  for (const name of names) {
    const scenario = SCENARIOS[name]
    const vendor = await startVendorProxy({ targetPort: modelPort, oneWayMs: scenario.links.vendorMs })
    try {
      results.push(await runScenario(scenario, { scripts, model, vendor, turns: Number(values.turns) }))
    } finally {
      await vendor.close()
    }
  }
} finally {
  await model.close()
  releasePort(modelPort)
}
for (const result of results) console.log(`${report(result)}\n`)
if (values.out) {
  await mkdir(values.out, { recursive: true })
  const file = path.join(values.out, `${names.join("+")}-${new Date().toISOString().replaceAll(":", "-")}.json`)
  await writeFile(file, JSON.stringify({ vendor: { ttftMs: Number(values.ttft), chunks: Number(values.chunks), cadenceMs: Number(values.cadence) }, results }, null, 2))
  console.log(`wrote ${file}`)
}
