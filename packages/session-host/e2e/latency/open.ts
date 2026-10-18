import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ScriptedModelServer } from "../../../harness/e2e/harness/scripted-model-server"
import { measureTurn, timedStream } from "../../../harness/e2e/perf/latency-client"
import { count, ms, sleep, summarize, summaryRow, type Summary } from "../../../harness/e2e/perf/pipes"
import type { VendorProxy } from "../../../harness/e2e/perf/vendor-proxy"
import { bootTopology, STAGING_LINKS, type Links, type Scripts, type Topology } from "./topology"

const MODEL = { providerID: "pi", modelID: "openai/gpt-4.1" }

/** The web app's first read of a session: its outline at the reader's viewport (`viewportQuery`, `session-reads.ts`). */
const VIEWPORT = "rows=40&cols=120&reasoning=0&shell=0&edit=0"

export const OPEN_SCENARIOS: Record<string, OpenScenario> = {
  "open-cold": { name: "open-cold", links: STAGING_LINKS, object: "cold", pauseMs: 1_000 },
  "open-warm": { name: "open-warm", links: STAGING_LINKS, object: "warm", pauseMs: 1_000 },
  "open-cold-cp-slow": { name: "open-cold-cp-slow", links: { ...STAGING_LINKS, cpMs: 400 }, object: "cold", pauseMs: 1_000 },
}

export type OpenScenario = {
  name: string
  links: Links
  /** `cold` restarts workerd before every open, so the relay room and the object both start from nothing; `warm` opens again on the same topology. */
  object: "cold" | "warm"
  pauseMs: number
}

type Read = { headers: number; body: number; status: number; serverTiming: string | undefined; text: string }

/** One open, every time in milliseconds after the press. */
export type OpenTimes = {
  outline: Read
  queue: Read
  open: Read
  /** The event stream's first bytes. */
  stream: number
  /** The object's own phases from the outline's `Server-Timing`. */
  hostStart: number | undefined
  hostServe: number | undefined
  /** When the room sent each read on to the object and when the object answered it. */
  room: Array<{ path: string; sent: number; answered: number | undefined }>
  controlPlane: Array<{ action: string; at: number; ms: number }>
  resolver: Array<{ path: string; at: number }>
  jwks: number[]
}

export type OpenResult = {
  scenario: OpenScenario
  opens: OpenTimes[]
  summary: {
    outlineHeaders: Summary | undefined
    outlineBody: Summary | undefined
    queueBody: Summary | undefined
    openBody: Summary | undefined
    stream: Summary | undefined
    roomSent: Summary | undefined
    objectAnswered: Summary | undefined
    hostStart: Summary | undefined
    hostServe: Summary | undefined
    firstControlPlaneAnswer: Summary | undefined
  }
  cpCalls: Record<string, number>
  resolverCalls: Record<string, number>
  jwksCalls: number
}

function timing(header: string | undefined, name: string): number | undefined {
  const match = header?.match(new RegExp(`(?:^|,\\s*)${name};dur=([\\d.]+)`))
  return match ? Number(match[1]) : undefined
}

async function timedRead(send: Topology["relay"], path: string, pressedAt: number): Promise<Read> {
  const response = await send(path)
  const headers = performance.now() - pressedAt
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`)
  return { headers, body: performance.now() - pressedAt, status: response.status, serverTiming: response.headers.get("server-timing") ?? undefined, text }
}

/**
 * The press of a rail row as the web app makes it: the outline at the
 * viewport, the queue, the open view and the event stream, all at once, and
 * the outline's body is the first transcript text on screen.
 */
async function press(topology: Topology, marker: string): Promise<OpenTimes> {
  const root = topology.root
  const pressedAt = performance.now()
  const before = { pipe: topology.pipe.length, cp: topology.cpCalls.length, resolver: topology.resolverCalls.length, jwks: topology.jwksCalls.length }
  const stream = timedStream(topology.relay(`/api/wr/events?sessionID=${root}`))
  const [outline, queue, open] = await Promise.all([
    timedRead(topology.relay, `/session/${root}/outline?${VIEWPORT}`, pressedAt),
    timedRead(topology.relay, `/session/${root}/queue`, pressedAt),
    timedRead(topology.relay, `/session/${root}?view=open`, pressedAt),
    stream.opened,
  ])
  const streamAt = performance.now() - pressedAt
  stream.close()
  if (!outline.text.includes(marker)) throw new Error(`The outline does not carry the turn's text ${marker}: ${outline.text.slice(0, 300)}`)
  return {
    outline, queue, open, stream: streamAt,
    hostStart: timing(outline.serverTiming, "host-start"), hostServe: timing(outline.serverTiming, "host-serve"),
    room: topology.pipe.slice(before.pipe).map((record) => ({ path: record.path, sent: record.arrivedAt - pressedAt, answered: record.answeredAt === undefined ? undefined : record.answeredAt - pressedAt })),
    controlPlane: topology.cpCalls.slice(before.cp).map((call) => ({ action: call.path, at: call.at + call.ms - pressedAt, ms: call.ms })),
    resolver: topology.resolverCalls.slice(before.resolver).map((call) => ({ path: call.path, at: call.at - pressedAt })),
    jwks: topology.jwksCalls.slice(before.jwks).map((at) => at - pressedAt),
  }
}

export async function runOpenScenario(scenario: OpenScenario, input: { scripts: Scripts; model: ScriptedModelServer; vendor: VendorProxy; opens: number }): Promise<OpenResult> {
  const persist = await mkdtemp(path.join(tmpdir(), "pi-latency-open-"))
  const boot = (world?: Topology["world"]) => bootTopology({
    scripts: input.scripts, persist, root: "ses_latency_open", links: scenario.links, vendor: { url: input.vendor.url, secret: "pi-latency-secret" },
    relayHostKey: "jwks", ...(world ? { world } : {}),
  })
  let topology = await boot()
  const opens: OpenTimes[] = []
  const cpCalls: string[] = []
  const resolverCalls: string[] = []
  let jwksCalls = 0
  const marker = `OPEN${scenario.name.replaceAll("-", "").toUpperCase()}`
  try {
    const created = await topology.relay(`/session/${topology.root}`, {
      method: "POST", headers: { "x-claxedo-session-registration-operation": `op_${topology.root}` },
      body: JSON.stringify({ harness: { id: "pi", access: "native" }, model: { providerID: MODEL.providerID, id: MODEL.modelID } }),
    })
    if (!created.ok) throw new Error(`Session create answered ${created.status}: ${await created.text()}\n${topology.stderr()}`)
    const stream = timedStream(topology.relay(`/api/wr/events?sessionID=${topology.root}`))
    await stream.opened
    input.model.scriptText({ marker, text: `The transcript's one assistant answer ${marker}` })
    await measureTurn({
      stream, sessionId: topology.root, timeoutMs: 15_000,
      send: () => topology.relay(`/session/${topology.root}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: `Reply with the scripted text ending in ${marker}` }], messageID: `msg_${marker}`, model: MODEL }) }),
    }).catch((error: unknown) => {
      const failed = stream.frames.find((frame) => frame.type === "session.error")
      throw new Error(`The opening turn failed: ${error instanceof Error ? error.message : String(error)}\n${failed ? JSON.stringify(failed.data) : ""}\n${topology.stderr()}`)
    })
    stream.close()
    await sleep(500)
    const reboot = async () => {
      cpCalls.push(...topology.cpCalls.map((call) => call.path))
      resolverCalls.push(...topology.resolverCalls.map((call) => call.path))
      jwksCalls += topology.jwksCalls.length
      await topology.dispose()
      topology = await boot(topology.world)
    }
    await reboot()
    if (scenario.object === "warm") {
      await press(topology, marker)
      await sleep(scenario.pauseMs)
    }
    for (let index = 0; index < input.opens; index++) {
      if (index > 0) {
        if (scenario.object === "cold") await reboot()
        else await sleep(scenario.pauseMs)
      }
      const open = await press(topology, marker)
      opens.push(open)
      if (index === 0) {
        process.stderr.write(`  object: ${open.room.map((hop) => `${hop.path.split("/").pop()}@${ms(hop.sent)}->${ms(hop.answered)}`).join(" ")}\n`)
        process.stderr.write(`  control plane: ${open.controlPlane.map((call) => `${call.action}@${ms(call.at)}`).join(" ")}; resolver: ${open.resolver.map((call) => `${call.path.split("/").pop()}@${ms(call.at)}`).join(" ")}; jwks: ${open.jwks.map(ms).join(" ")}\n`)
      }
      process.stderr.write(`${scenario.name} open ${index + 1}: outline headers ${ms(open.outline.headers)} body ${ms(open.outline.body)} queue ${ms(open.queue.body)} open ${ms(open.open.body)} stream ${ms(open.stream)} (host-start ${ms(open.hostStart)} host-serve ${ms(open.hostServe)})\n`)
    }
    cpCalls.push(...topology.cpCalls.map((call) => call.path))
    resolverCalls.push(...topology.resolverCalls.map((call) => call.path))
    jwksCalls += topology.jwksCalls.length
  } finally {
    await topology.dispose()
    await rm(persist, { recursive: true, force: true })
  }
  const of = (read: (open: OpenTimes) => number | undefined) => summarize(opens.flatMap((open) => { const value = read(open); return value === undefined ? [] : [value] }))
  return {
    scenario, opens,
    summary: {
      outlineHeaders: of((open) => open.outline.headers),
      outlineBody: of((open) => open.outline.body),
      queueBody: of((open) => open.queue.body),
      openBody: of((open) => open.open.body),
      stream: of((open) => open.stream),
      roomSent: of((open) => open.room.find((hop) => hop.path.endsWith("/outline"))?.sent),
      objectAnswered: of((open) => open.room.find((hop) => hop.path.endsWith("/outline"))?.answered),
      hostStart: of((open) => open.hostStart),
      hostServe: of((open) => open.hostServe),
      firstControlPlaneAnswer: of((open) => open.controlPlane[0]?.at),
    },
    cpCalls: count(cpCalls),
    resolverCalls: count(resolverCalls),
    jwksCalls,
  }
}

export function reportOpen(result: OpenResult): string {
  const { summary } = result
  return [
    `== ${result.scenario.name} (open; ${result.scenario.object} object and room; links ${JSON.stringify(result.scenario.links)}; relay host key over JWKS)`,
    summaryRow("press -> room sent outline", summary.roomSent),
    summaryRow("press -> object answered", summary.objectAnswered),
    summaryRow("press -> outline headers", summary.outlineHeaders),
    summaryRow("press -> outline body", summary.outlineBody),
    summaryRow("press -> queue body", summary.queueBody),
    summaryRow("press -> open view body", summary.openBody),
    summaryRow("press -> stream open", summary.stream),
    summaryRow("object host-start", summary.hostStart),
    summaryRow("object host-serve", summary.hostServe),
    summaryRow("press -> first cp answer", summary.firstControlPlaneAnswer),
    `control-plane calls ${JSON.stringify(result.cpCalls)}`,
    `relay resolver calls ${JSON.stringify(result.resolverCalls)}`,
    `relay JWKS fetches by the object ${result.jwksCalls}`,
  ].join("\n")
}
