import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createRuntimeCredentialIssuer } from "./first-party-mcp"
import { createHarnessServices } from "./harness-services"
import { createProcessObserver, type ProcessObserverEvent } from "./managed-processes/process-observer"
import { createTranscriptResolver } from "./transcript-resolver"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function fixture() {
  const calls: unknown[] = []
  const log = { debug: (message: string) => calls.push(["debug", message]),
    info: (message: string) => calls.push(["info", message]),
    warn: (message: string) => calls.push(["warn", message]),
    error: (message: string) => calls.push(["error", message]) }
  const clock = { now: () => 123, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  const issuer = createRuntimeCredentialIssuer({ runtimeId: "r1", workspaceId: "w1" })
  const patternEvaluator = async () => { calls.push(["pattern"]) }
  const services = createHarnessServices({ ownership: volatileLaunchOwnership(), log, clock,
    patternEvaluator,
    transcripts: { workspaceId: "w1", resolver: {
      register: async (input) => { calls.push(["register", input]); return { state: "ready" as const, handle: "h1" } },
      open: async (input) => { calls.push(["open", input]); return { state: "ready" as const, messages: ["entry"] } },
    } },
    firstPartyMcpLaunch: { baseUrl: "http://127.0.0.1:2593", issuer, enabledToolGroups: () => ["sessions"] },
  })
  return { services, calls, log, clock, issuer, patternEvaluator }
}

test("host services use the owned spawn, transcript resolver, clock and logger", async () => {
  const { services, calls, log, clock } = fixture()
  expect(services.clock).toBe(clock)
  expect(services.log).toBe(log)
  services.log.info("created")
  expect(await services.transcripts.register({ parentSessionId: "s1", providerKind: "cursor", filePath: "/tmp/t.json" }))
    .toEqual({ state: "ready", handle: "h1" })
  expect(await services.transcripts.open?.({ parentSessionId: "s1", handle: "h1" }))
    .toEqual({ state: "ready", messages: ["entry"] })
  expect(calls).toEqual([["info", "created"],
    ["register", { workspaceId: "w1", parentSessionId: "s1", providerKind: "cursor", filePath: "/tmp/t.json" }],
    ["open", { workspaceId: "w1", parentSessionId: "s1", handle: "h1" }]])
  const child = await services.spawn({ file: "/bin/sh", args: ["-c", "printf ready"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    { role: "probe", label: "service boundary", signal: new AbortController().signal })
  expect((await child.exited).code).toBe(0)
  expect(await child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })).toEqual({ stopped: true })
})

test("first-party MCP is minted only for local sessions", () => {
  const { services, issuer } = fixture()
  expect(services.firstPartyMcp("s1", "remote")).toBeUndefined()
  const local = services.firstPartyMcp("s1", "local")
  expect(local).toMatchObject({ kind: "http", name: "claxedo", headers: { Authorization: issuer.header("s1") } })
  expect(local && "url" in local ? local.url : "").toContain("session=s1")
})

test("host services keep the supplied process-wide pattern evaluator", async () => {
  const { services, calls, patternEvaluator } = fixture()
  expect(services.patternEvaluator).toBe(patternEvaluator)
  await services.patternEvaluator([])
  expect(calls).toEqual([["pattern"]])
})

test("every transport receives the parent- and workspace-bound opaque transcript registrar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-native-transcript-"))
  roots.push(root)
  const providerRoot = path.join(root, "cursor", "sessions")
  await fs.mkdir(providerRoot, { recursive: true })
  const valid = path.join(providerRoot, "agent-1.jsonl")
  const invalid = path.join(root, "outside.jsonl")
  await Promise.all([fs.writeFile(valid, '{"type":"text","text":"hello"}\n'), fs.writeFile(invalid, "{}\n")])
  const { services } = fixture()
  const registrar = createHarnessServices({
    ownership: volatileLaunchOwnership(),
    log: services.log,
    clock: services.clock,
    patternEvaluator: services.patternEvaluator,
    transcripts: {
      workspaceId: "workspace-a",
      resolver: createTranscriptResolver({
        workspaceId: "workspace-a",
        providers: { "cursor-agent": { root: providerRoot, format: "jsonl" } },
        authorizeParent: ({ parentSessionId }) => parentSessionId === "parent-a",
        createHandle: () => "cursor_transcript_opaque",
      }),
    },
  }).transcripts

  expect(await registrar.register({ parentSessionId: "parent-a", providerKind: "cursor-agent", filePath: valid }))
    .toEqual({ state: "ready", handle: "cursor_transcript_opaque" })
  expect(await registrar.open?.({ parentSessionId: "parent-a", handle: "cursor_transcript_opaque" }))
    .toEqual({ state: "ready", messages: [{ type: "text", text: "hello" }] })
  expect(await registrar.register({ parentSessionId: "parent-a", providerKind: "cursor-agent", filePath: invalid }))
    .toMatchObject({ state: "unavailable", reason: "outside-root" })
  const unauthorized = await registrar.register({ parentSessionId: "parent-b", providerKind: "cursor-agent", filePath: valid })
  expect(unauthorized).toMatchObject({ state: "unavailable", reason: "unauthorized" })
  expect(JSON.stringify(unauthorized)).not.toContain(providerRoot)
})

test("a harness spawn is not yet registered with the workspace process observer: pinned until the host services carry it", async () => {
  const { log, clock, patternEvaluator } = fixture()
  const events: ProcessObserverEvent[] = []
  const input = { ownership: volatileLaunchOwnership(), log, clock, patternEvaluator,
    processObserver: createProcessObserver({ sink: (event) => events.push(event) }) }
  const services = createHarnessServices(input)
  const child = await services.spawn({ file: "/bin/sh", args: ["-c", "printf ready"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    { role: "harness", label: "observed harness", sessionId: "s1", signal: new AbortController().signal })
  expect((await child.exited).code).toBe(0)
  expect(await child.retire({ at: Date.now() + 5_000, signal: new AbortController().signal })).toEqual({ stopped: true })
  const observed = () => expect(events).toContainEqual(expect.objectContaining({ type: "registered",
    descriptor: expect.objectContaining({ kind: "harness", role: "harness", pid: child.pid, sessionId: "s1" }) }))
  expect(observed).toThrow("toContainEqual")
  expect(events).toEqual([])
})
