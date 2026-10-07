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
    backend.server.scriptTool({ name: "bash", input: { command: `echo $$ > '${pidFile}'; exec sleep 60` }, whenPromptIncludes: "PISLEEP" })
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

test("a background job outlives its Pi bash call and ends when the session closes", async () => {
  const context = await piContext("pi-background")
  const backend = context.backend as PiBackend
  try {
    const pidFile = path.join(backend.directory, "background.pid")
    backend.server.scriptTool({ name: "bash", input: { command: `sleep 30 & echo $! > '${pidFile}'; echo started` }, whenPromptIncludes: "PIBACKGROUND" })
    const started = Date.now()
    const events = await collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PIBACKGROUND"), context.turnBroker()))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(events.some(({ event }) => event.type === "tool-output" && JSON.stringify(event.output).includes("started"))).toBe(true)
    const pid = Number(await fs.readFile(pidFile, "utf8"))
    expect(processAlive(pid)).toBe(true)
    await context.transport.close(context.session)
    expect(await pollUntil(() => processAlive(pid) ? undefined : true, Date.now() + 10_000)).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a background compaction that completes after the turn is published and its spend metered against the last reply", async () => {
  const context = await piContext("pi-idle-compaction")
  const backend = context.backend as PiBackend
  const metered: unknown[] = []
  context.ports.meterUsage = (usage: unknown) => { metered.push(usage) }
  try {
    await context.transport.configure(context.session, {
      credentials: { ...backend.credentials, direct: { scripted: { delivery: "direct", baseUrl: backend.server.url, apiPath: "/v1", secret: "custom-secret", authKind: "api-key" } } },
      providerDefinitions: [{ id: "scripted", name: "Scripted", npm: "@ai-sdk/openai-compatible", baseURL: backend.server.v1Url, headers: {},
        models: { model: { name: "Scripted model" } }, credentialProviderId: "scripted", credentialSource: "account" }],
    })
    const model = { providerID: "pi", modelID: "scripted/model" }
    await collect(context.transport.send(context.session, { ...context.turn("Reply with exactly this one token: PIEARLY"), model }, context.turnBroker()))
    const release = backend.server.holdTextReplies("context summarization assistant")
    const events = await collect(context.transport.send(context.session,
      { ...context.turn(`Reply with exactly this one token: PILARGE ${"filler ".repeat(50_000)}`), model }, context.turnBroker()))
    expect(events.at(-1)?.event.type).toBe("finish")
    release()
    const completed = await pollUntil(() => context.ports.sessionEvents.find(({ event }) =>
      (event as { type?: string; phase?: string }).type === "session-compaction" && (event as { phase?: string }).phase === "completed"), Date.now() + 15_000)
    expect(completed).toBeDefined()
    expect(await pollUntil(() => metered.length ? true : undefined, Date.now() + 15_000)).toBe(true)
    expect(metered[0]).toMatchObject({ sessionId: "s1", assistantMessageId: "a1", usage: { type: "usage" } })
  } finally { await context.close() }
}, 60_000)

test("a Claxedo turn sent twice runs once: Pi answers the repeat from the settled submission", async () => {
  const context = await piContext("pi-dedupe")
  const backend = context.backend as PiBackend
  try {
    const turn = context.turn("Reply with exactly this one token: PIONCE")
    expect((await collect(context.transport.send(context.session, turn, context.turnBroker()))).at(-1)?.event.type).toBe("finish")
    expect((await collect(context.transport.send(context.session, turn, context.turnBroker()))).map(({ event }) => event.type)).toEqual(["finish"])
    expect(backend.server.requests.filter((request) => request.prompt.includes("PIONCE") && !request.prompt.includes("Scripted Session"))).toHaveLength(1)
  } finally { await context.close() }
}, 60_000)

test("a Pi draft lists the models of providers the owner has only an account row for, and a turn on one is refused before any request", async () => {
  const context = await piContext("pi-account-catalog")
  const backend = context.backend as PiBackend
  try {
    const accountsOnly = { ...backend.credentials, direct: {},
      providers: { openai: { baseUrl: backend.server.url, placeholder: "broker-placeholder", authMode: "bearer" as const } } }
    const preview = await context.transport.config!.options({ draft: { ...context.start, credentials: accountsOnly } }, "peek")
    const models = preview.options.find((option) => option.id === "model")
    const ids = models && "selectOptions" in models ? (models.selectOptions ?? []).map((row) => row.id) : []
    expect(ids).toContain("openai/gpt-4.1")
    expect(new Set(ids.map((id) => id.split("/")[0]))).toEqual(new Set(["openai"]))
    expect(await context.transport.configure(context.session, { credentials: accountsOnly })).toMatchObject({ state: "applied" })
    const turn = collect(context.transport.send(context.session, context.turn("Reply with exactly this one token: PINODIRECT"), context.turnBroker()))
    await expect(turn).rejects.toThrow(/direct_credential_required/)
    expect(backend.server.requests.some((request) => request.prompt.includes("PINODIRECT"))).toBe(false)
  } finally { await context.close() }
}, 60_000)
