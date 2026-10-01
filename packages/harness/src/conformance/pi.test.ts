import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createTestServices } from "./test-support/services"
import { processAlive } from "../../e2e/harness/process-alive"
import { runConformance, setupConformance, type ConformanceBackend, withUndeliverableFile, type SuiteBackend } from "./test-support/run"
import { assertListedCommandsRun } from "./test-support/commands"
import { PINNED_PI } from "../../e2e/harness/pinned-pi"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { PiRpcTransport } from "../transports/pi-rpc"
import { PI_RANGE } from "../transports/pi-rpc/version"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"
import { pollUntil } from "./test-support/poll"
import type { RoutedEvent } from "../contract"

type PiBackend = SuiteBackend & { root: string; agentDir: string; server: Awaited<ReturnType<typeof startScriptedModelServer>> }

const extension = `export default function (pi) {
  pi.on("session_start", (_event, ctx) => ctx.ui.notify("Pi conformance extension loaded", "info"))
  pi.on("input", (event) => event.text.includes("PIHANDLEDSTEER") ? { action: "handled" } : undefined)
  pi.registerCommand("conformance-notify", {
    description: "Answer without starting a run",
    handler: async (_args, ctx) => { ctx.ui.notify("Pi conformance handled", "info") },
  })
  pi.registerCommand("conformance-later", {
    description: "Start a run of its own",
    handler: async () => { pi.sendUserMessage("Reply with exactly this one token: PILATER") },
  })
  pi.registerCommand("conformance-ui", {
    description: "Exercise Pi extension UI",
    handler: async (args, ctx) => {
      ctx.ui.notify("Pi conformance notice", "info")
      ctx.ui.setStatus("conformance", "Pi conformance status")
      ctx.ui.setWidget("conformance", ["Pi conformance widget"])
      ctx.ui.setTitle("Pi conformance title")
      ctx.ui.setEditorText("Pi conformance editor")
      const mode = args.trim()
      const value = mode === "expire" ? await ctx.ui.confirm("Expire", "Expire this request?", { timeout: 100 })
        : mode === "input" ? await ctx.ui.input("Input", "")
        : mode === "editor" ? await ctx.ui.editor("Editor", "")
        : await ctx.ui.select("Choose", ["Allow", "Deny"])
      pi.setSessionName(value === "Allow" || value === true ? "Pi allowed" : "Pi denied")
      pi.sendUserMessage("Reply with exactly this one token: PICONFORMUI")
    },
  })
}

`

async function backend(): Promise<PiBackend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-conformance-"))
  const directory = path.join(root, "work")
  const agentDir = path.join(root, "pi-agent")
  await fs.mkdir(directory)
  await fs.mkdir(agentDir)
  await fs.mkdir(path.join(agentDir, "extensions"))
  await fs.writeFile(path.join(agentDir, "extensions", "conformance.ts"), extension)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const authFile = path.join(agentDir, "auth.json")
  await fs.writeFile(authFile, Buffer.from('{"sentinel":"owner-auth-must-stay"}\n'))
  const port = await reservePort()
  const server = await startScriptedModelServer({ port, red: false })
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    openai: { baseUrl: server.v1Url, apiKey: "pi-conformance-placeholder" },
  } }))
  return {
    root, agentDir, directory, authFile, server, uiCommand: "conformance-ui", owner: { kind: "machine-owner" },
    sharedSender: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    harness: { id: "pi", access: "native" }, expectedMcp: "session",
    model: { providerID: "pi", modelID: "openai/gpt-4.1" },
    credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "conformance" },
    hold: (marker) => server.holdTextReplies(marker),
    held: (marker) => server.textGateReached(marker),
    processesPerLaunch: 1,
    firstLaunchProcesses: 2,
    scriptTool: (name, input) => server.scriptTool({ name, input }),
    scriptThinking: (input) => server.scriptText(input),
    unrunnableTurn: withUndeliverableFile,
    close: async () => { await server.close(); releasePort(port); await fs.rm(root, { recursive: true, force: true }) },
  }
}

test("Pi failed configuration restart removes the retired session", async () => {
  const context = await setupConformance({
    name: "pi failed restart", backend,
    makeTransport(services, state) {
      const pi = state as PiBackend
      return new PiRpcTransport(services, { binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner",
        canUseOwnLogin: true, stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir,
        runtime: process.execPath, env: process.env })
    },
  })
  try {
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIWRITTEN"), context.turnBroker())) {}
    const entry = (context.transport as unknown as { entries: Map<string, { profile: { sessionDir: string } }> }).entries.get("s1")!
    await fs.rm(entry.profile.sessionDir, { recursive: true, force: true })
    await expect(context.transport.configure(context.session,
      { credentials: { ...context.backend.credentials, leaseGeneration: "changed" } })).rejects.toThrow()
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("disconnected")
    const send = async () => {
      for await (const _event of context.transport.send(context.session, context.turn("after failed restart"), context.turnBroker())) {}
    }
    await expect(send()).rejects.toThrow("not attached")
  } finally { await context.close() }
}, 30_000)

test("Pi settles a turn and cancels its unanswered dialog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-settled-dialog-"))
  const script = path.join(root, "scripted-pi.js")
  await fs.writeFile(script, `if (process.argv.includes("--version")) { console.log("${PI_RANGE.max}"); process.exit(0); }
const readline = require("node:readline");
const fs = require("node:fs");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "extension_ui_response") {
    fs.writeFileSync(process.env.PI_DIALOG_RESPONSE_FILE, JSON.stringify(request));
    return;
  }
  send({ type: "response", id: request.id, command: request.type, success: true,
    data: request.type === "get_state" ? { sessionId: "scripted-pi" } : request.type === "prompt" ? { disposition: "started" } : {} });
  if (request.type === "prompt") {
    send({ type: "extension_ui_request", id: "orphan-dialog", method: "confirm", title: "Orphan", message: "Still open?" });
    send({ type: "agent_settled" });
  }
});`)
  const context = await setupConformance({
    name: "pi orphan dialog", backend: async () => ({ root, directory: root, harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "openai/gpt-4.1" }, owner: { kind: "machine-owner" }, unrunnableTurn: withUndeliverableFile,
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" },
      close: async () => { await fs.rm(root, { recursive: true, force: true }) } }),
    makeTransport(services, state) {
      const pi = state as PiBackend
      return new PiRpcTransport(services, { binary: script, placement: "loopback", machineOwnerUserId: "owner",
        canUseOwnLogin: true, stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: path.join(pi.root, "agent"),
        runtime: process.execPath, env: { ...process.env, PI_DIALOG_RESPONSE_FILE: path.join(root, "response.json") } })
    },
  })
  try {
    const running = (async () => {
      for await (const _event of context.transport.send(context.session, context.turn("dialog"), context.turnBroker())) {}
    })()
    const completed = running.then(() => "settled", (error: unknown) => `failed: ${String(error)}`)
    const entry = (context.transport as unknown as { entries: Map<string, { stream: { busy: boolean } }> }).entries.get("s1")!
    for (let attempt = 0; entry.stream.busy && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entry.stream.busy).toBe(false)
    await expect(Promise.race([
      completed,
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 2_000)),
    ])).resolves.toBe("settled")
    expect(context.owner.broker.list({ sessionId: "s1" }).filter((row) => row.request.kind === "question")).toHaveLength(0)
    expect(JSON.parse(await fs.readFile(path.join(root, "response.json"), "utf8"))).toEqual({
      type: "extension_ui_response", id: "orphan-dialog", cancelled: true,
    })
  } finally { await context.close() }
}, 15_000)

runConformance({
  name: "pi-rpc",
  backend,
  makeTransport(services, state) {
    const pi = state as PiBackend
    return new PiRpcTransport(services, {
      binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir, runtime: process.execPath, env: process.env,
    })
  },
})

test("a listed Pi extension command runs as a slash prompt", async () => {
  const context = await setupConformance({ name: "pi command proof", backend,
    makeTransport(services, state) {
      const pi = state as PiBackend
      return new PiRpcTransport(services, { binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner",
        canUseOwnLogin: true, stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir,
        runtime: process.execPath, env: process.env })
    } })
  try {
    await assertListedCommandsRun({ transport: context.transport, session: context.session, turn: context.turn,
      turnBroker: context.turnBroker, proves: (name) => name === "conformance-ui", args: () => "choose",
      whileRunning: async () => {
        let question = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "question")
        for (let attempt = 0; !question && attempt < 500; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          question = context.owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "question")
        }
        expect(question).toBeDefined()
        if (question) expect((await context.owner.broker.answer(question.request.requestId,
          { kind: "answers", answers: [["Allow"]] }, { sessionId: "s1" })).ok).toBe(true)
      },
      observe: (_name, events) => expect(events.some(({ event }) => event.type === "session-title" && event.title === "Pi allowed")).toBe(true) })
  } finally { await context.close() }
}, 60_000)

test("Pi script uses the composed runtime even when PATH starts with a failing node", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-script-runtime-"))
  const bin = path.join(root, "bin")
  await fs.mkdir(bin)
  const marker = path.join(root, "wrong-node")
  await fs.writeFile(path.join(bin, "node"), `#!/bin/sh\ntouch '${marker}'\nexit 91\n`, { mode: 0o755 })
  const script = path.join(root, "pi.js")
  await fs.writeFile(script, `if (process.argv.includes("--version")) { console.log("${PI_RANGE.max}"); process.exit(0); }
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type,
    success: true, data: { sessionId: "composed-runtime" } }) + "\\n");
});`)
  const services = createTestServices()
  const transport = new PiRpcTransport(services, { binary: script, runtime: process.execPath,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, placement: "loopback",
    machineOwnerUserId: "owner", canUseOwnLogin: true, stateRoot: path.join(root, "state"), ownerAgentDir: path.join(root, "agent") })
  try {
    const session = await transport.start({ sessionId: "s1", workspaceId: "w1", directory: root, locality: "local",
      owner: { kind: "machine-owner" }, config: { harness: { id: "pi", access: "native" } },
      projection: { generation: "g1", pluginRoots: [], mcpServers: [], notApplied: [] },
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }, { rebind: async (upstreamSessionId: string) =>
        ({ sessionId: "s1", workspaceId: "w1", directory: root, connectionId: "pi-rpc", upstreamSessionId }) } as never)
    expect(session.binding.upstreamSessionId).toBe("composed-runtime")
    await transport.close(session)
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" })
  } finally { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
}, 15_000)

runConformance({
  name: "pi-rpc brokered",
  async backend() {
    const state = await backend()
    const rotated: { port: number; server: Awaited<ReturnType<typeof startScriptedModelServer>> }[] = []
    const origin = { actor: { kind: "person" as const, userId: "member" }, via: "relay" as const, reissued: false }
    const credentials = { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: { openai: { baseUrl: state.server.url, apiPath: "/v1", placeholder: "pi-broker-placeholder", authMode: "api-key" as const } },
      secrets: {}, leaseGeneration: "brokered" }
    const root = path.join(state.root, "plugin")
    await fs.mkdir(path.join(root, "extensions"), { recursive: true })
    await fs.writeFile(path.join(root, "extensions", "conformance.ts"), extension)
    return { ...state, owner: origin.actor, origin, credentials, authFile: undefined,
      sharedSender: { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false },
      projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "conformance", root, skillNames: [], dataRoot: root }] },
      rotate: async () => {
        const port = await reservePort()
        const server = await startScriptedModelServer({ port, red: false })
        rotated.push({ port, server })
        return { credentials: { ...credentials, providers: { openai: { ...credentials.providers.openai, baseUrl: server.url } },
          leaseGeneration: "rotated" }, observed: () => server.requests.length > 0 }
      },
      close: async () => {
        await Promise.all(rotated.map(async ({ port, server }) => { await server.close(); releasePort(port) }))
        await state.close()
      },
    }
  },
  makeTransport(services, state) {
    const pi = state as PiBackend
    return new PiRpcTransport(services, {
      binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir, runtime: process.execPath, env: process.env,
    })
  },
})

function piTransport(services: ReturnType<typeof createTestServices>, state: ConformanceBackend, env = process.env) {
  const pi = state as PiBackend
  return new PiRpcTransport(services, { binary: PINNED_PI, placement: "loopback", machineOwnerUserId: "owner",
    canUseOwnLogin: true, stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir, runtime: process.execPath,
    env: { ...env, HOME: path.join(pi.root, "home") } })
}

test("a Pi process death mid-turn fails the turn through the channel's exit", async () => {
  const context = await setupConformance({ name: "pi process death", backend, makeTransport: piTransport })
  try {
    const release = context.backend.hold!("PIDEATH")
    const running = (async () => {
      for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIDEATH"), context.turnBroker())) {}
    })()
    const settled = running.then(() => "completed", (error: unknown) => String(error))
    await context.backend.held!("PIDEATH")
    const pi = context.services.processes.at(-1)!
    process.kill(pi.pid, "SIGKILL")
    expect(await Promise.race([settled, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 5_000))])).toContain("Pi process exited")
    release()
    expect(await pi.exited).toMatchObject({ signal: "SIGKILL" })
  } finally { await context.close() }
}, 30_000)

test("Pi reads back a clamped thinking level and refuses the turn", async () => {
  const context = await setupConformance({ name: "pi clamped effort", backend, makeTransport: piTransport })
  try {
    const before = (context.backend as PiBackend).server.requests.length
    const run = async () => {
      for await (const _event of context.transport.send(context.session, { ...context.turn("Reply with exactly this one token: PICLAMP"), effort: "xhigh" }, context.turnBroker())) {}
    }
    await expect(run()).rejects.toThrow("Pi does not run openai/gpt-4.1 at thinking level xhigh; it kept off")
    expect((context.backend as PiBackend).server.requests.length).toBe(before)
  } finally { await context.close() }
}, 30_000)

test("Pi lists only its profile's runnable models and their thinking levels through the config group", async () => {
  const context = await setupConformance({ name: "pi config group", backend,
    makeTransport: (services, state) => piTransport(services, state, { PATH: process.env.PATH }) })
  try {
    const config = context.transport.config!
    const preview = await config.options({ session: context.session }, "probe")
    expect(preview.resolvedModel).toEqual({ id: "openai/gpt-4.1", name: "GPT-4.1" })
    const model = preview.options.find((option) => option.id === "model")
    expect(model?.selectOptions?.some((choice) => choice.id === "openai/o3")).toBe(true)
    expect(new Set(model?.selectOptions?.map((choice) => choice.id.split("/")[0]))).toEqual(new Set(["openai"]))
    expect(model?.selectOptions?.every((choice) => choice.connected === true)).toBe(true)
    expect(preview.options.find((option) => option.category === "thought_level")).toBeUndefined()
    expect(await config.options({ session: context.session }, "peek")).toEqual(preview)
    const reasoning = await config.options({ session: context.session, model: { providerID: "pi", modelID: "openai/o3" } }, "probe")
    expect(reasoning.resolvedModel?.id).toBe("openai/o3")
    const effort = reasoning.options.find((option) => option.category === "thought_level")
    expect(effort?.selectOptions?.map((choice) => choice.id)).toEqual(["low", "medium", "high"])
    expect(["low", "medium", "high"]).toContain(String(effort?.currentValue))
    const { sessionId: _sessionId, title: _title, instructions: _instructions, ...draft } = context.start
    expect(await config.options({ draft }, "probe")).toEqual(preview)
    expect(await config.permissionModes({ session: context.session })).toEqual({ modes: [], unsupported: "Pi has no permission modes", appliesFrom: "next-turn" })
    await expect(config.setPermissionMode(context.session, "auto")).rejects.toThrow("Pi has no permission modes")
    expect(context.services.processes.slice(2)).toHaveLength(2)
    for (const probe of context.services.processes.slice(2)) expect(await probe.exited).toBeDefined()
  } finally { await context.close() }
}, 60_000)

test("Pi names a session through the Claxedo title extension and hides its command", async () => {
  const context = await setupConformance({ name: "pi title", backend, makeTransport: piTransport })
  try {
    const pi = context.backend as PiBackend
    await fs.access(path.join(pi.root, "claxedo", "extensions", "claxedo-session-title.ts"))
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PITITLE"), context.turnBroker())) {}
    const commands = await context.transport.commands!.list({ session: context.session })
    expect(commands.some((command) => command.name === "conformance-ui")).toBe(true)
    expect(commands.some((command) => command.name === "claxedo-title")).toBe(false)
    const title = await context.transport.naming!.generateTitle!(context.session, { directory: context.backend.directory, system: SESSION_TITLE_SYSTEM_PROMPT,
      user: "<conversation>\nUser: Reply with exactly this one token: PITITLE\n</conversation>", model: context.backend.model, signal: AbortSignal.timeout(20_000) })
    expect(title).toBe("Session PITITLE")
    const entry = (context.transport as unknown as { entries: Map<string, { rpc: { request(type: string): Promise<unknown> } }> }).entries.get("s1")!
    expect((await entry.rpc.request("get_state") as { sessionName?: string }).sessionName).toBe("Session PITITLE")
    expect((await context.transport.capabilities({ directory: context.backend.directory })).titles).toBe("side-request")
    await fs.access(path.join(pi.agentDir, "extensions", "conformance.ts"))
    expect((await fs.readdir(pi.agentDir)).filter((name) => name.endsWith(".ts"))).toEqual([])
  } finally { await context.close() }
}, 60_000)

test("a failed Pi retirement during configure keeps the session and its process for close", async () => {
  let pid: number | undefined
  const context = await setupConformance({
    name: "pi retirement refused",
    async backend() {
      const state = await backend()
      return { ...state, configureServices(services) {
        const spawn = services.spawn.bind(services)
        services.spawn = async (command, options) => {
          const child = await spawn(command, options)
          if (options.label !== "Pi RPC" || pid !== undefined) return child
          pid = child.pid
          let refused = false
          const retire = child.retire.bind(child)
          return { ...child, retire: async (deadline) => {
            if (refused) return retire(deadline)
            refused = true
            return { stopped: false, error: { code: "test", message: "retirement refused once" } }
          } }
        }
      } }
    },
    makeTransport: piTransport,
  })
  try {
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIRETIRE"), context.turnBroker())) {}
    await expect(context.transport.configure(context.session, { credentials: { ...context.backend.credentials, leaseGeneration: "changed" } }))
      .rejects.toThrow("retirement refused once")
    expect(processAlive(pid!)).toBe(true)
    expect(context.transport.health?.connection(context.backend.directory, "s1").state).toBe("ready")
    expect(context.transport.health?.runtime(context.backend.directory, "s1").status).toBe("degraded")
    await context.transport.close(context.session)
    expect(await context.services.processes[1]!.exited).toBeDefined()
    expect(processAlive(pid!)).toBe(false)
  } finally {
    await context.close()
    if (pid !== undefined && processAlive(pid)) process.kill(pid, "SIGKILL")
  }
}, 30_000)

test("Pi stopped before its prompt is sent ends the turn without prompting and serves the next turn", async () => {
  const context = await setupConformance({ name: "pi stop before prompt", backend,
    makeTransport: (services, state) => piTransport(services, state) })
  try {
    const server = (context.backend as PiBackend).server
    const within = <T>(promise: Promise<T>) => Promise.race([promise.then(() => "ended"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5_000))])
    const stoppedBefore = new AbortController()
    stoppedBefore.abort()
    const early = context.transport.send(context.session, context.turn("Reply with exactly this one token: PISTOPPEDEARLY"), context.turnBroker(stoppedBefore.signal))
    expect(await within((async () => { for await (const _event of early) {} })())).toBe("ended")
    const stoppedDuring = new AbortController()
    const during = context.transport.send(context.session, context.turn("Reply with exactly this one token: PISTOPPEDLATE"),
      context.turnBroker(stoppedDuring.signal))[Symbol.asyncIterator]()
    const first = during.next()
    stoppedDuring.abort()
    expect(await within((async () => { if (!(await first).done) for (;;) if ((await during.next()).done) break })())).toBe("ended")
    expect(server.requests.filter((request) => request.prompt.includes("PISTOPPED"))).toEqual([])
    expect(await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 5_000, signal: new AbortController().signal }))
      .toMatchObject({ execution: "terminal" })
    const events: unknown[] = []
    for await (const event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIAFTERSTOP"), context.turnBroker())) events.push(event)
    expect(server.requests.some((request) => request.prompt.includes("PIAFTERSTOP"))).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a Pi cancel that arrives before the prompt stops that turn, whether or not its signal was aborted", async () => {
  const context = await setupConformance({ name: "pi cancel before prompt", backend,
    makeTransport: (services, state) => piTransport(services, state) })
  try {
    const server = (context.backend as PiBackend).server
    const turn = context.transport.send(context.session, context.turn("Reply with exactly this one token: PICANCELEARLY"), context.turnBroker())[Symbol.asyncIterator]()
    const first = turn.next()
    const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 5_000, signal: new AbortController().signal })
    expect(outcome).toMatchObject({ execution: "terminal" })
    const ended = Promise.race([(async () => { if (!(await first).done) for (;;) if ((await turn.next()).done) break })().then(() => "ended"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 5_000))])
    expect(await ended).toBe("ended")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(server.requests.filter((request) => request.prompt.includes("PICANCELEARLY"))).toEqual([])
  } finally { await context.close() }
}, 60_000)

test("a Pi model error that Pi retries and recovers shows as retrying and leaves the turn completed", async () => {
  const context = await setupConformance({ name: "pi recovered retry", backend, makeTransport: piTransport })
  try {
    const stop = (context.backend as PiBackend).server.scriptError({ marker: "PIRETRYONCE", status: 500, message: "overloaded" })
    const types: string[] = []
    let text = ""
    for await (const { event } of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIRETRYONCE"), context.turnBroker())) {
      types.push(event.type)
      if (event.type === "session-retry") stop()
      if (event.type === "text-delta") text += event.delta
    }
    expect(types).toContain("session-retry")
    expect(types).not.toContain("error")
    expect(types.at(-1)).toBe("finish")
    expect(text).toContain("PIRETRYONCE")
  } finally { await context.close() }
}, 60_000)

async function within<T>(promise: Promise<T>, ms: number): Promise<T | "hung"> {
  return Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms))])
}

test("a Pi extension command that starts no run ends its turn at Pi's handled answer", async () => {
  const context = await setupConformance({ name: "pi handled command", backend, makeTransport: piTransport })
  try {
    const events: string[] = []
    const run = (async () => {
      for await (const { event } of context.transport.send(context.session, context.turn("/conformance-notify"), context.turnBroker())) {
        events.push(event.type === "harness-notice" ? `notice:${event.message}` : event.type)
      }
    })()
    expect(await within(run.then(() => "ended"), 5_000)).toBe("ended")
    expect(events).toEqual(["notice:Pi conformance handled", "finish"])
    expect(context.ports.sessionEvents.map(({ event }) => (event as { message?: string }).message)).toContain("Pi conformance extension loaded")
  } finally { await context.close() }
}, 60_000)

test("a run Pi starts on its own after a handled command reaches Claxedo as a provider turn with its prompt", async () => {
  const context = await setupConformance({ name: "pi provider turn", backend, makeTransport: piTransport })
  try {
    const run = (async () => { for await (const _event of context.transport.send(context.session, context.turn("/conformance-later"), context.turnBroker())) {} })()
    expect(await within(run.then(() => "ended"), 5_000)).toBe("ended")
    const drained = () => (context.ports.drained as RoutedEvent[]).map(({ event }) => event)
    await pollUntil(() => drained().some((event) => event.type === "finish") ? true : undefined, Date.now() + 10_000)
    expect(context.ports.providerInputs).toEqual([{ reason: "provider", detail: "Reply with exactly this one token: PILATER" }])
    expect(drained().flatMap((event) => event.type === "text-delta" ? [event.delta] : []).join("")).toContain("PILATER")
    const after: string[] = []
    for await (const { event } of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIAFTERLATER"), context.turnBroker())) after.push(event.type)
    expect(after.at(-1)).toBe("finish")
  } finally { await context.close() }
}, 60_000)

test("a steer a Pi extension takes as input settles declined instead of waiting for the conversation", async () => {
  const context = await setupConformance({ name: "pi handled steer", backend, makeTransport: piTransport })
  try {
    const release = context.backend.hold!("PISTEERHOST")
    const running = (async () => { for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PISTEERHOST"), context.turnBroker())) {} })()
    await context.backend.held!("PISTEERHOST")
    const result = await context.transport.steer!.steer(context.session, { turnId: "t1", assistantMessageId: "a1" },
      context.turn("PIHANDLEDSTEER", "msg_handled"))
    release()
    await running
    expect(result).toEqual({ ok: false, status: "declined", message: "A Pi extension took the steer as input, so it is not in the conversation" })
  } finally { await context.close() }
}, 60_000)

test("a Pi that exits while starting names Pi's own reason, not only its exit code", async () => {
  const context = await setupConformance({ name: "pi start failure", backend, makeTransport: piTransport })
  try {
    const plugin = path.join(context.backend.directory, "broken-extension")
    await fs.mkdir(plugin)
    await fs.writeFile(path.join(plugin, "index.ts"), "export default function () { throw new Error(\"PIBROKENEXTENSION\") }\n")
    const start = { ...context.start, sessionId: "s-broken", projection: { generation: "g2", mcpServers: [], notApplied: [],
      pluginRoots: [{ pluginInstanceId: "broken", root: plugin, skillNames: [], dataRoot: plugin }] } }
    await expect(context.transport.start(start, context.sessionBroker)).rejects.toThrow(/Pi process exited \(1\): [\s\S]*PIBROKENEXTENSION/)
  } finally { await context.close() }
}, 60_000)

test("a Pi process that dies during a run Pi started itself ends that provider turn instead of holding the session", async () => {
  const context = await setupConformance({ name: "pi provider turn death", backend, makeTransport: piTransport })
  try {
    const release = context.backend.hold!("PILATER")
    for await (const _event of context.transport.send(context.session, context.turn("/conformance-later"), context.turnBroker())) {}
    await context.backend.held!("PILATER")
    const entry = (context.transport as unknown as { entries: Map<string, { stream: { busy: boolean }; rpc: { process: { pid: number } } }> }).entries.get("s1")!
    expect(entry.stream.busy).toBe(true)
    process.kill(entry.rpc.process.pid, "SIGKILL")
    const idle = await pollUntil(() => entry.stream.busy ? undefined : true, Date.now() + 5_000)
    release()
    expect(idle).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("a Pi session reconfigured before its first prompt keeps its session id and runs the next turn", async () => {
  const context = await setupConformance({ name: "pi configure before prompt", backend, makeTransport: piTransport })
  try {
    const update = await context.transport.configure(context.session, { credentials: { ...context.backend.credentials, leaseGeneration: "before-first-prompt" } })
    expect(update).toEqual({ state: "applied" })
    const events: string[] = []
    for await (const { event } of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIFRESHCONFIG"), context.turnBroker())) events.push(event.type)
    expect(events.at(-1)).toBe("finish")
    const entry = (context.transport as unknown as { entries: Map<string, { rpc: { request(type: string): Promise<unknown> } }> }).entries.get("s1")!
    expect((await entry.rpc.request("get_state") as { sessionId: string }).sessionId).toBe(context.session.binding.upstreamSessionId)
  } finally { await context.close() }
}, 60_000)

test("a Pi session that never had a turn attaches after a restart as a fresh Pi session under its id", async () => {
  const context = await setupConformance({ name: "pi attach before prompt", backend, makeTransport: piTransport })
  try {
    const entries = (context.transport as unknown as { entries: Map<string, { profile: { sessionDir: string }; rpc: { request(type: string): Promise<unknown> } }> }).entries
    const sessionDir = entries.get("s1")!.profile.sessionDir
    const upstream = context.session.binding.upstreamSessionId
    await context.transport.close(context.session)
    expect((await fs.readdir(sessionDir)).filter((name) => name.includes(upstream))).toEqual([])
    const attached = await context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: false }, context.sessionBroker)
    expect(attached.binding.upstreamSessionId).toBe(upstream)
    const events: string[] = []
    for await (const { event } of context.transport.send(attached, context.turn("Reply with exactly this one token: PIFRESHATTACH"), context.turnBroker())) events.push(event.type)
    expect(events.at(-1)).toBe("finish")
    expect((await entries.get("s1")!.rpc.request("get_state") as { sessionId: string }).sessionId).toBe(upstream)
  } finally { await context.close() }
}, 60_000)

test("a Pi session that had a turn refuses to attach once its session file is gone", async () => {
  const context = await setupConformance({ name: "pi attach lost file", backend, makeTransport: piTransport })
  try {
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PIWRITTEN"), context.turnBroker())) {}
    const entry = (context.transport as unknown as { entries: Map<string, { profile: { sessionDir: string } }> }).entries.get("s1")!
    const upstream = context.session.binding.upstreamSessionId
    await context.transport.close(context.session)
    const written = (await fs.readdir(entry.profile.sessionDir)).filter((name) => name.endsWith(`_${upstream}.jsonl`))
    expect(written).toHaveLength(1)
    await fs.rm(path.join(entry.profile.sessionDir, written[0]!))
    const processes = context.services.processes.length
    await expect(context.transport.attach({ ...context.start, binding: context.session.binding, upstreamHasTurns: true }, context.sessionBroker))
      .rejects.toMatchObject({ name: "PiTransportError", code: "session", retryable: false, detail: { upstreamSessionId: upstream } })
    expect(context.services.processes).toHaveLength(processes)
  } finally { await context.close() }
}, 60_000)
