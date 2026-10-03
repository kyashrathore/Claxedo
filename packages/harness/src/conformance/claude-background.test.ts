import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensurePinnedClaude, PINNED_CLAUDE } from "../../e2e/harness/pinned-claude"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import type { RoutedEvent, TurnInput } from "../contract"
import { ClaudeSdkTransport } from "../transports/claude-sdk"
import { authority, MemoryPorts } from "./test-support/memory-ports"
import { pollUntil } from "./test-support/poll"
import { createTestServices } from "./test-support/services"

const BACKGROUND_SECONDS = 8

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

test.each([false, true])("a Claude background task survives follow-ups and model/effort changes (%s) and reports on the same process", async (followups) => {
  await ensurePinnedClaude()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-background-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.mkdir(path.join(root, "user-claude"))
  const port = await reservePort()
  const server = await startScriptedModelServer({ port, red: false })
  const marker = path.join(directory, "background-finished.txt")
  server.scriptTool({ name: "Bash", input: { command: `sleep ${BACKGROUND_SECONDS}; echo done > ${marker}`, run_in_background: true, description: "background sleep" } })
  const env = { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_GROWTHBOOK: "1", DISABLE_UPDATES: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" }
  const services = createTestServices()
  const pids: number[] = []
  const ports = new MemoryPorts()
  const harness = { id: "claude" as const, access: "native" as const }
  const model = { providerID: "anthropic", modelID: "default" }
  Object.assign(ports, { clock: services.clock, config: () => ({ harness, model, permissionMode: "bypassPermissions" }) })
  ports.directories.set("s1", directory)
  ports.current.set("s1", { ...authority, directory })
  const owner = createRequestBroker(ports)
  const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
  const broker = createSessionBroker(owner, { sessionId: "s1", directory, workspaceId: "w1", origin })
  const transport = new ClaudeSdkTransport({ ...services, spawn: async (command, options) => {
    const owned = await services.spawn(command, options)
    if (options.role === "harness") pids.push(owned.pid)
    return owned
  } }, { executable: PINNED_CLAUDE, configRoot: path.join(root, "claxedo-claude"), userConfigRoot: path.join(root, "user-claude"), env })
  try {
    const started = await transport.start({ sessionId: "s1", workspaceId: "w1", directory, locality: "local", owner: origin.actor,
      config: { harness, model, permissionMode: "bypassPermissions" }, model,
      credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", leaseGeneration: "background", secrets: {},
        providers: { anthropic: { baseUrl: server.url, placeholder: "claude-background-placeholder", authMode: "api-key" } } },
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } }, broker)
    const turn: TurnInput = { turnId: "t1", userMessageId: "u-t1", assistantMessageId: "a-t1", origin, model, todos: [], effort: "high",
      prompt: { agent: "claude", assistantMessageId: "a-t1", parts: [{ type: "text", text: "start the background job" }] } }
    const turnBroker = createTurnBroker(owner, { authority: { ...authority, directory, turnId: "t1" }, origin, signal: new AbortController().signal })
    const began = Date.now()
    const events: RoutedEvent[] = []
    for await (const event of transport.send(started, turn, turnBroker)) events.push(event)
    const turnMs = Date.now() - began

    expect(turnMs).toBeLessThan(BACKGROUND_SECONDS * 1_000)
    expect(events.some(({ event }) => event.type === "finish")).toBe(true)
    expect(pids).toHaveLength(1)
    expect(alive(pids[0]!)).toBe(true)
    await fs.access(marker).then(() => { throw new Error("the background command finished inside its own turn") }, () => undefined)

    if (followups) {
      for (const [index, effort] of ["high", "low", undefined].entries()) {
        const turnId = `followup-${index}`
        const prompt: TurnInput = { ...turn, turnId, assistantMessageId: turnId, userMessageId: `u-${turnId}`, effort, model: index === 2 ? { ...model, modelID: "sonnet" } : model,
          prompt: { ...turn.prompt, assistantMessageId: turnId, parts: [{ type: "text", text: `Reply with exactly this one token: FOLLOWUP${index}` }] } }
        const nextBroker = createTurnBroker(owner, { authority: { ...authority, directory, turnId }, origin, signal: new AbortController().signal })
        for await (const event of transport.send({ ...started, binding: ports.bindings.get("s1")! }, prompt, nextBroker)) events.push(event)
        expect(pids).toHaveLength(1)
        expect(alive(pids[0]!)).toBe(true)
      }
      await transport.config.setModelSettings({ ...started, binding: ports.bindings.get("s1")! }, { model, effort: "low" })
      expect(pids).toHaveLength(1)
      expect(alive(pids[0]!)).toBe(true)
    }

    const ownTurn = await pollUntil(() => (ports.drained as RoutedEvent[]).find(({ event, route }) => route?.kind !== "child" && event.type === "finish"),
      Date.now() + 30_000)
    expect(ownTurn).toBeDefined()
    expect(await fs.readFile(marker, "utf8")).toBe("done\n")
    const notified = server.requests.at(-1)?.prompt ?? ""
    expect(notified).toContain("task-notification")
    expect(notified).toContain("completed")
    if (followups) {
      const byPrompt = (token: string) => server.requests.find((request) => request.prompt.includes(token))
      const notification = server.requests.at(-1)
      expect(notification?.model).toBe(byPrompt("FOLLOWUP0")?.model)
      expect(notification?.model).not.toBe(byPrompt("FOLLOWUP2")?.model)
      expect((notification?.body as { output_config?: { effort?: string } }).output_config?.effort).toBe("low")
    }
    expect(pids).toHaveLength(1)
    expect(await pollUntil(() => alive(pids[0]!) ? undefined : true, Date.now() + 15_000)).toBe(true)
  } finally {
    await transport.dispose()
    await server.close()
    releasePort(port)
    await fs.rm(root, { recursive: true, force: true })
  }
}, 60_000)
