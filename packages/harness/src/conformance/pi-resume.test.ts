import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { createRequestBroker, createSessionBroker } from "../broker"
import type { HarnessBinding, PendingRequest, RoutedEvent } from "../contract"
import { processAlive } from "../../e2e/harness/process-alive"
import { pollUntil } from "./test-support/poll"
import { authority, MemoryPorts, origin } from "./test-support/memory-ports"
import { piBackend, piTransport } from "../../e2e/harness/pi-conformance"
import { createTestServices } from "./test-support/services"

test("a Pi run killed mid-tool resumes on attach as a continuation turn that answers with the interrupted result", async () => {
  const backend = await piBackend("pi-resume")
  const pidFile = path.join(backend.directory, "sleep.pid")
  backend.server.scriptTool({ name: "bash", input: { command: `echo $$ > '${pidFile}'; exec sleep 60` }, whenPromptIncludes: "PICRASH" })
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../../e2e/harness/pi-crash-child.ts"), backend.root, backend.directory, backend.server.url],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, HOME: path.join(backend.root, "home") } })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  const pid = await pollUntil(async () => await Bun.file(pidFile).exists() ? Number(await Bun.file(pidFile).text()) || undefined : undefined, Date.now() + 20_000)
  const { binding } = JSON.parse(output.split("\n")[0]!) as { binding: HarnessBinding }
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  process.kill(pid!, "SIGKILL")
  const services = createTestServices()
  const ports = new MemoryPorts()
  Object.assign(ports, { clock: services.clock })
  ports.directories.set("s1", backend.directory)
  ports.current.set("s1", { ...authority, directory: backend.directory })
  const broker = createSessionBroker(createRequestBroker(ports), { sessionId: "s1", directory: backend.directory, workspaceId: "w1", origin })
  const transport = piTransport(services, backend)
  try {
    await transport.attach({ sessionId: "s1", workspaceId: "w1", directory: backend.directory, locality: "local", owner: backend.owner,
      config: { harness: backend.harness, model: backend.model }, model: backend.model, credentials: backend.credentials,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, binding, upstreamHasTurns: true }, broker)
    const finished = await pollUntil(() => ports.drained.some((event) => (event as RoutedEvent).event.type === "finish") || undefined, Date.now() + 20_000)
    expect(finished).toBe(true)
    expect(ports.providerInputs.map((input) => input.reason)).toEqual(["continuation"])
    const events = ports.drained as RoutedEvent[]
    expect(events.some(({ event }) => event.type === "tool-error")).toBe(true)
    expect(events.some(({ event }) => event.type === "text-delta" && event.delta.includes("PICRASH"))).toBe(true)
    expect(processAlive(pid!)).toBe(false)
  } finally {
    await transport.dispose()
    await backend.close()
  }
}, 60_000)

test("an approval a restart interrupted is asked again rather than replaying the cancellation the person never gave", async () => {
  const backend = await piBackend("pi-resume-ask")
  backend.server.scriptTool({ name: "write", input: { path: "approved.txt", content: "approved after restart\n" }, whenPromptIncludes: "PICRASH" })
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "../../e2e/harness/pi-crash-child.ts"), backend.root, backend.directory, backend.server.url, "ask"],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, HOME: path.join(backend.root, "home") } })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  const lines = () => output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { binding?: HarnessBinding; asked?: PendingRequest })
  const asked = await pollUntil(() => lines().find((line) => line.asked)?.asked, Date.now() + 20_000)
  child.kill("SIGKILL")
  await new Promise((resolve) => child.once("exit", resolve))
  const services = createTestServices()
  const ports = new MemoryPorts()
  Object.assign(ports, { clock: services.clock })
  ports.directories.set("s1", backend.directory)
  ports.current.set("s1", { ...authority, directory: backend.directory })
  await ports.persistAnswer(asked!, { kind: "cancelled" }, false)
  const owner = createRequestBroker(ports)
  const broker = createSessionBroker(owner, { sessionId: "s1", directory: backend.directory, workspaceId: "w1", origin })
  const transport = piTransport(services, backend)
  try {
    await transport.attach({ sessionId: "s1", workspaceId: "w1", directory: backend.directory, locality: "local", owner: backend.owner,
      config: { harness: backend.harness, model: backend.model, permissionMode: "ask" }, model: backend.model, credentials: backend.credentials,
      projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, binding: lines()[0]!.binding!, upstreamHasTurns: true }, broker)
    const again = await pollUntil(() => owner.broker.list({ sessionId: "s1" }).find((row) => row.request.kind === "permission"), Date.now() + 20_000)
    expect(again?.request.requestId).toStartWith(`${asked!.request.requestId}:`)
    expect((await owner.broker.answer(again!.request.requestId, { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await pollUntil(() => ports.drained.some((event) => (event as RoutedEvent).event.type === "finish") || undefined, Date.now() + 20_000)).toBe(true)
    expect(await fs.readFile(path.join(backend.directory, "approved.txt"), "utf8")).toBe("approved after restart\n")
  } finally {
    await transport.dispose()
    await backend.close()
  }
}, 60_000)
