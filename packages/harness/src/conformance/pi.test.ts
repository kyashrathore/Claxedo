import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { processAlive } from "../../e2e/harness/process-alive"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"
import type { RoutedEvent } from "../contract"
import { pollUntil } from "./test-support/poll"
import { piBackend, piTransport, type PiBackend } from "../../e2e/harness/pi-conformance"
import { runConformance, setupConformance } from "./test-support/run"

runConformance({ name: "pi-durable", backend: () => piBackend(), makeTransport: (services, backend) => piTransport(services, backend as PiBackend) })

async function collect(events: AsyncIterable<RoutedEvent>): Promise<RoutedEvent[]> {
  const seen: RoutedEvent[] = []
  for await (const event of events) seen.push(event)
  return seen
}

const piContext = (name: string) => setupConformance({ name, backend: () => piBackend(name),
  makeTransport: (services, backend) => piTransport(services, backend as PiBackend) })

test("a Pi turn writes a real file through its own tools, streams usage, spends only the direct secret, and titles the session", async () => {
  const context = await piContext("pi-tool-turn")
  const backend = context.backend as PiBackend
  try {
    backend.server.scriptTool({ name: "write", input: { path: "written.txt", content: "pi wrote this\n" }, whenPromptIncludes: "PIWRITE" })
    const events = await collect(context.transport.send(context.session, context.turn("Write the file, then reply PIWRITE"), context.turnBroker()))
    expect(await fs.readFile(path.join(backend.directory, "written.txt"), "utf8")).toBe("pi wrote this\n")
    expect(events.some(({ event }) => event.type === "tool-start" && event.toolName === "write")).toBe(true)
    expect(events.some(({ event }) => event.type === "tool-output")).toBe(true)
    expect(events.some(({ event }) => event.type === "usage")).toBe(true)
    expect(events.at(-1)?.event.type).toBe("finish")
    expect(new Set(backend.server.requests.map((request) => request.authorization))).toEqual(new Set(["Bearer pi-direct-secret"]))
    const title = await context.transport.naming!.generateTitle!(context.session, { directory: backend.directory,
      system: SESSION_TITLE_SYSTEM_PROMPT, user: "Reply PITITLE", signal: new AbortController().signal })
    expect(title).toBe("Scripted Session")
  } finally { await context.close() }
}, 60_000)

test("stopping a Pi turn mid-bash kills the command's process and settles the turn cancelled", async () => {
  const context = await piContext("pi-stop")
  const backend = context.backend as PiBackend
  try {
    const pidFile = path.join(backend.directory, "sleep.pid")
    backend.server.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 60` }, whenPromptIncludes: "PISLEEP" })
    const controller = new AbortController()
    const running = collect(context.transport.send(context.session, context.turn("Run it PISLEEP"), context.turnBroker(controller.signal)))
    const pid = await pollUntil(async () => await Bun.file(pidFile).exists() ? Number(await Bun.file(pidFile).text()) || undefined : undefined, Date.now() + 10_000)
    expect(processAlive(pid!)).toBe(true)
    expect((await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 10_000, signal: controller.signal })).execution).toBe("terminal")
    expect((await running).at(-1)?.event.type).toBe("cancelled")
    expect(processAlive(pid!)).toBe(false)
  } finally { await context.close() }
}, 60_000)

test("a Pi model request that hits the context window compacts and still answers", async () => {
  const context = await piContext("pi-compaction")
  const backend = context.backend as PiBackend
  try {
    for (const fill of ["ONE", "TWO", "THREE"]) {
      await collect(context.transport.send(context.session, context.turn(`Reply with exactly this one token: PIFILL${fill} ${"filler ".repeat(6000)}`),
        context.turnBroker()))
    }
    backend.server.scriptError({ marker: "PICOMPACT", status: 400, message: "Your input exceeds the context window of this model", once: true })
    const events = await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PICOMPACT"), context.turnBroker()))
    expect(events.filter(({ event }) => event.type === "session-compaction").map(({ event }) => event.type === "session-compaction" && event.phase))
      .toEqual(["started", "completed"])
    expect(events.at(-1)?.event.type).toBe("finish")
  } finally { await context.close() }
}, 60_000)

test("an overloaded Pi model request shows as the session retrying and the turn still completes", async () => {
  const context = await piContext("pi-retry")
  const backend = context.backend as PiBackend
  try {
    backend.server.scriptError({ marker: "PIRETRY", status: 529, message: "overloaded", once: true })
    const events = await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PIRETRY"), context.turnBroker()))
    expect(events.some(({ event }) => event.type === "session-retry")).toBe(true)
    expect(events.some(({ event }) => event.type === "text-delta" && event.delta.includes("PIRETRY"))).toBe(true)
    expect(events.at(-1)?.event.type).toBe("finish")
  } finally { await context.close() }
}, 60_000)

test("ask mode routes a Pi write through the broker, and a denial blocks the tool", async () => {
  const context = await piContext("pi-ask")
  const backend = context.backend as PiBackend
  try {
    expect((await context.transport.config!.setPermissionMode(context.session, "ask")).currentModeId).toBe("ask")
    backend.server.scriptTool({ name: "write", input: { path: "denied.txt", content: "no" }, whenPromptIncludes: "PIASK" })
    const running = collect(context.transport.send(context.session, context.turn("Write it PIASK"), context.turnBroker()))
    const pending = await pollUntil(() => context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission"), Date.now() + 10_000)
    expect(pending?.request.requestId).toStartWith("pi-tool:")
    expect((await context.owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    const events = await running
    expect(events.some(({ event }) => event.type === "tool-error")).toBe(true)
    expect(events.at(-1)?.event.type).toBe("finish")
    await expect(fs.access(path.join(backend.directory, "denied.txt"))).rejects.toThrow()
  } finally { await context.close() }
}, 60_000)

test("the model's Pi question reaches the person and their answer returns to the model", async () => {
  const context = await piContext("pi-question")
  const backend = context.backend as PiBackend
  try {
    backend.server.scriptTool({ name: "question", input: { question: "Which colour?", options: ["red", "blue"] }, whenPromptIncludes: "PIQUESTION" })
    const running = collect(context.transport.send(context.session, context.turn("Ask me PIQUESTION"), context.turnBroker()))
    const pending = await pollUntil(() => context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "question"), Date.now() + 10_000)
    expect((await context.owner.broker.answer(pending!.request.requestId, { kind: "answers", answers: [["blue"]] }, { sessionId: "s1" })).ok).toBe(true)
    const events = await running
    expect(events.some(({ event }) => event.type === "tool-output" && JSON.stringify(event.output).includes("blue"))).toBe(true)
    expect(backend.server.requests.at(-1)?.prompt).toContain("blue")
  } finally { await context.close() }
}, 60_000)
