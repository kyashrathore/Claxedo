import { expect, test } from "bun:test"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import { createRuntimeCredentialIssuer } from "./first-party-mcp"
import { createHarnessServices } from "./harness-services"

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
    { role: "probe", label: "service boundary" })
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
