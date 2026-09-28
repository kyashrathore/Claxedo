import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { ConfigOptionsPreview } from "../../contract"
import { scriptedPi } from "./test-support/scripted-pi"

const modelIds = (preview: ConfigOptionsPreview) =>
  preview.options.find((option) => option.id === "model")?.selectOptions?.map((choice) => choice.id)

test("a draft's Pi catalog is served from cache while its files are unchanged, and an edited .pi/settings.json probes again", async () => {
  const pi = await scriptedPi()
  try {
    const settings = path.join(pi.directory, ".pi", "settings.json")
    await fs.mkdir(path.dirname(settings))
    await fs.writeFile(settings, JSON.stringify({ defaultModel: "first" }))
    const read = () => pi.transport.config.options({ draft: pi.draft() }, "probe")
    expect(modelIds(await read())).toEqual(["scripted/first"])
    expect(modelIds(await read())).toEqual(["scripted/first"])
    expect(pi.probes()).toHaveLength(1)
    await fs.writeFile(settings, JSON.stringify({ defaultModel: "second-model" }))
    expect(modelIds(await pi.transport.config.options({ draft: pi.draft() }, "peek"))).toBeUndefined()
    expect(modelIds(await read())).toEqual(["scripted/second-model"])
    expect(pi.probes()).toHaveLength(2)
    await fs.mkdir(path.join(pi.root, "owner-agent"), { recursive: true })
    await fs.writeFile(path.join(pi.root, "owner-agent", "settings.json"), "{}")
    await read()
    expect(pi.probes()).toHaveLength(3)
  } finally { await pi.close() }
})

test("a kept Pi catalog is probed again when a parent folder's .pi settings or an extension that can register providers changes", async () => {
  const pi = await scriptedPi()
  try {
    const read = () => pi.transport.config.options({ draft: pi.draft() }, "probe")
    await read()
    await fs.mkdir(path.join(pi.root, ".pi"))
    await fs.writeFile(path.join(pi.root, ".pi", "settings.json"), "{}")
    await read()
    await read()
    expect(pi.probes()).toHaveLength(2)
    const extension = path.join(pi.root, "owner-agent", "extensions", "provider.ts")
    await fs.mkdir(path.dirname(extension), { recursive: true })
    await fs.writeFile(extension, "export default function () {}")
    await read()
    await fs.writeFile(extension, "export default function (pi) { pi.registerProvider }")
    await read()
    const packaged = path.join(pi.directory, ".pi", "extensions", "gateway", "index.ts")
    await fs.mkdir(path.dirname(packaged), { recursive: true })
    await read()
    await fs.writeFile(packaged, "export default function () {}")
    await read()
    await read()
    expect(pi.probes()).toHaveLength(6)
  } finally { await pi.close() }
})

test("an unsettled probe retirement still answers, never degrades Pi, and is retried when its process exits and before the next launch", async () => {
  const pi = await scriptedPi({ onLaunch: (launch) => {
    if (launch.options.role === "probe") launch.wire.retirement = { stopped: false, error: { code: "ownership_unverified", message: "ps timed out" } }
  } })
  try {
    const read = pi.transport.config.options({ draft: pi.draft() }, "probe")
    const pending = () => pi.probes()[0]!.wire
    expect(modelIds(await read)).toEqual(["scripted/default-model"])
    expect(pending().retirements).toBe(1)
    expect(pi.transport.health.runtime(pi.directory)).toEqual({ status: "ok" })
    await pi.transport.start(pi.start(), pi.broker)
    expect(pending().retirements).toBe(2)
    pending().retirement = { stopped: true }
    pending().exit({ code: null, signal: "SIGKILL" })
    await pending().exited
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pending().retirements).toBe(3)
    await pi.transport.start(pi.start(), pi.broker)
    expect(pending().retirements).toBe(3)
    expect(pi.health.changes).toBe(0)
  } finally { await pi.close() }
})

test("a held launch whose retry is still retiring never delays the next launch, and one retry runs at a time", async () => {
  const pi = await scriptedPi({ onLaunch: (launch) => {
    if (launch.options.role === "probe") launch.wire.retirement = { stopped: false, error: { code: "ownership_unverified", message: "ps timed out" } }
  } })
  try {
    await pi.transport.config.options({ draft: pi.draft() }, "probe")
    const pending = pi.probes()[0]!.wire
    let release!: () => void
    pending.retirementGate = new Promise<void>((resolve) => { release = resolve })
    const started = await Promise.race([pi.transport.start(pi.start(), pi.broker).then(() => "started"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1_000))])
    expect(started).toBe("started")
    expect(pending.retirements).toBe(2)
    await pi.transport.start(pi.start(), pi.broker)
    expect(pending.retirements).toBe(2)
    pending.retirement = { stopped: true }
    release()
    await pending.exited
    await new Promise((resolve) => setTimeout(resolve, 0))
    await pi.transport.start(pi.start(), pi.broker)
    expect(pending.retirements).toBe(2)
  } finally { await pi.close() }
})

test("a Pi process lost under a session reads degraded until its replacement starts, and a close is not a loss", async () => {
  const pi = await scriptedPi()
  try {
    const session = await pi.transport.start(pi.start(), pi.broker)
    const first = pi.launches[0]!.wire
    first.exit({ code: 9, signal: null })
    await first.exited
    expect(pi.transport.health.runtime(pi.directory, "s1")).toEqual({ status: "degraded", reason: "harness_process_lost", message: "Pi process exited (9)" })
    expect(pi.health.changes).toBe(1)
    const replaced = await pi.transport.attach({ ...pi.start(), binding: session.binding }, pi.broker)
    expect(pi.transport.health.runtime(pi.directory, "s1")).toEqual({ status: "ok" })
    expect(pi.health.changes).toBe(2)
    await pi.transport.close(replaced)
    expect(pi.launches[1]!.wire.retirements).toBe(1)
    expect(pi.transport.health.runtime(pi.directory, "s1")).toEqual({ status: "ok" })
    expect(pi.health.changes).toBe(2)
  } finally { await pi.close() }
})

test("a local Pi session connects Claxedo's MCP through its extension, and a remote one is launched without it", async () => {
  const server = { kind: "http" as const, name: "claxedo", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer session-token" } }
  const pi = await scriptedPi({ firstPartyMcp: (_sessionId, locality) => locality === "local" ? server : undefined })
  try {
    await pi.transport.start(pi.start("remote"), pi.broker)
    await pi.transport.start(pi.start("local"), pi.broker)
    expect(pi.mcpRequests).toEqual([["s1", "remote"], ["s1", "local"]])
    const [remote, local] = pi.launches
    expect(remote!.command.args.some((arg) => arg.endsWith("claxedo-first-party-mcp.ts"))).toBe(false)
    expect(JSON.stringify(remote!.wire.received)).not.toContain("session-token")
    expect(local!.command.args.some((arg) => arg.endsWith("claxedo-first-party-mcp.ts"))).toBe(true)
    const [handoff] = local!.handoffs
    expect(handoff).toEqual({ file: expect.stringContaining(path.join(pi.root, "state")), mode: 0o600,
      content: JSON.stringify({ name: "claxedo", url: server.url, headers: server.headers }) })
    expect(local!.wire.received.filter((frame) => frame.type === "prompt").map((frame) => frame.message)).toEqual([`/claxedo-mcp ${handoff!.file}`])
    expect(JSON.stringify(local!.wire.received)).not.toContain("session-token")
    await expect(fs.stat(handoff!.file)).rejects.toThrow("ENOENT")
    expect(JSON.stringify(local!.command)).not.toContain("session-token")
  } finally { await pi.close() }
})

test("a Pi launch whose Claxedo MCP command is not registered sends nothing to the model, is retired and refuses the start", async () => {
  const pi = await scriptedPi({ unregistered: ["claxedo-mcp"],
    firstPartyMcp: () => ({ kind: "http", name: "claxedo", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer session-token" } }) })
  try {
    await expect(pi.transport.start(pi.start(), pi.broker)).rejects.toThrow("Pi has not registered /claxedo-mcp")
    const launch = pi.launches[0]!
    expect(launch.wire.received.filter((frame) => frame.type === "prompt")).toEqual([])
    expect(launch.wire.retirements).toBe(1)
    expect(await fs.readdir(path.join(pi.root, "state", "mcp-handoff"))).toEqual([])
  } finally { await pi.close() }
})

test("a Pi launch whose Claxedo MCP connection fails is retired and refuses the start", async () => {
  const pi = await scriptedPi({ mcpFailure: "Claxedo MCP initialize failed (401)",
    firstPartyMcp: () => ({ kind: "http", name: "claxedo", url: "http://127.0.0.1:1/mcp", headers: {} }) })
  try {
    await expect(pi.transport.start(pi.start(), pi.broker)).rejects.toThrow("Claxedo MCP initialize failed (401)")
    expect(pi.launches[0]!.wire.retirements).toBe(1)
    expect(pi.transport.health.connection(pi.directory, "s1").state).toBe("disconnected")
  } finally { await pi.close() }
})
