import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { createRequestBroker, createSessionBroker } from "../broker"
import type { HarnessBinding, RoutedEvent } from "../contract"
import { processAlive } from "../../e2e/harness/process-alive"
import { pollUntil } from "./test-support/poll"
import { authority, MemoryPorts, origin } from "./test-support/memory-ports"
import { piBackend, piTransport } from "../../e2e/harness/pi-conformance"
import { createTestServices } from "./test-support/services"

test("a Pi run killed mid-tool resumes on attach as a continuation turn that answers with the interrupted result", async () => {
  const backend = await piBackend("pi-resume")
  const pidFile = path.join(backend.directory, "sleep.pid")
  backend.server.scriptTool({ name: "bash", input: { command: `echo $$ > ${pidFile}; exec sleep 60` }, whenPromptIncludes: "PICRASH" })
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
