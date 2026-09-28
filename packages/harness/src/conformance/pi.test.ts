import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createTestServices } from "./test-support/services"
import { processAlive } from "../../e2e/harness/process-alive"
import { runConformance, setupConformance, type ConformanceBackend, withUndeliverableFile } from "./test-support/run"
import { assertListedCommandsRun } from "./test-support/commands"
import { ensurePinnedPi, PINNED_PI } from "../../e2e/harness/pinned-pi"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { PiRpcTransport } from "../transports/pi-rpc"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"

type PiBackend = ConformanceBackend & { root: string; agentDir: string; server: Awaited<ReturnType<typeof startScriptedModelServer>> }

const extension = `export default function (pi) {
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
  await ensurePinnedPi()
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
    harness: { id: "pi", access: "native" }, expectedMcp: "none",
    model: { providerID: "pi", modelID: "openai/gpt-4.1" },
    credentials: { providers: {}, secrets: {}, leaseGeneration: "conformance" },
    hold: (marker) => server.holdTextReplies(marker),
    held: (marker) => server.textGateReached(marker),
    scriptTool: (name, input) => server.scriptTool({ name, input }),
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
  await fs.writeFile(script, `const readline = require("node:readline");
const fs = require("node:fs");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "extension_ui_response") {
    fs.writeFileSync(process.env.PI_DIALOG_RESPONSE_FILE, JSON.stringify(request));
    return;
  }
  send({ type: "response", id: request.id, command: request.type, success: true,
    data: request.type === "get_state" ? { sessionId: "scripted-pi" } : {} });
  if (request.type === "prompt") {
    send({ type: "extension_ui_request", id: "orphan-dialog", method: "confirm", title: "Orphan", message: "Still open?" });
    send({ type: "agent_settled" });
  }
});`)
  const context = await setupConformance({
    name: "pi orphan dialog", backend: async () => ({ root, directory: root, harness: { id: "pi", access: "native" },
      model: { providerID: "pi", modelID: "openai/gpt-4.1" }, owner: { kind: "machine-owner" }, unrunnableTurn: withUndeliverableFile,
      credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" },
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
    const entry = (context.transport as unknown as { entries: Map<string, { settled: boolean }> }).entries.get("s1")!
    for (let attempt = 0; !entry.settled && attempt < 500; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entry.settled).toBe(true)
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
  await fs.writeFile(script, `const readline = require("node:readline");
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
      credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }, { rebind: async (upstreamSessionId: string) =>
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
    const credentials = { providers: { openai: { baseUrl: state.server.url, apiPath: "/v1", placeholder: "pi-broker-placeholder", authMode: "api-key" as const } },
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
    canUseOwnLogin: true, stateRoot: path.join(pi.root, "claxedo"), ownerAgentDir: pi.agentDir, runtime: process.execPath, env })
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
    makeTransport: (services, state) => piTransport(services, state, { PATH: process.env.PATH, HOME: process.env.HOME }) })
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
    expect(context.services.processes.filter((child) => child !== context.services.processes[0])).toHaveLength(2)
    for (const probe of context.services.processes.slice(1)) expect(await probe.exited).toBeDefined()
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
          if (options.role !== "harness" || pid !== undefined) return child
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
    expect(await context.services.processes[0]!.exited).toBeDefined()
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
