import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { createTestServices } from "./test-support/services"
import { runConformance, setupConformance, type ConformanceBackend, withUndeliverableFile } from "./test-support/run"
import { assertListedCommandsRun } from "./test-support/commands"
import { ensurePinnedPi, PINNED_PI } from "../../e2e/harness/pinned-pi"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { PiRpcTransport } from "../transports/pi-rpc"

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
    const credentials = { providers: { openai: { baseUrl: state.server.url, placeholder: "pi-broker-placeholder", authMode: "api-key" as const } },
      secrets: {}, leaseGeneration: "brokered" }
    const root = path.join(state.root, "plugin")
    await fs.mkdir(path.join(root, "extensions"), { recursive: true })
    await fs.writeFile(path.join(root, "extensions", "conformance.ts"), extension)
    return { ...state, owner: origin.actor, origin, credentials, authFile: undefined,
      sharedSender: { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false },
      projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "conformance", root, dataRoot: root }] },
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
