import { expect, test } from "bun:test"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { volatileLaunchOwnership, type CreationIdentity } from "@claxedo/process-ownership/launch"
import type { AgentProcessDescriptor, AgentProcessObserver } from "@claxedo/process-ownership/process-observer"
import { ownDirectClaudeLaunch, spawnObservedClaudeCodeProcess } from "./launch"

function identity(startedAtMs: number): CreationIdentity {
  return {
    pid: 4242,
    processGroupId: 4242,
    startSecond: String(Math.floor(startedAtMs / 1000)),
    bootTime: "1",
    parentPid: 1,
    startedAtMs,
    source: "darwin-ps",
  }
}

test("a launch whose pid was recycled records no identity, so its retirement signals nothing", async () => {
  const ownership = volatileLaunchOwnership()
  const launch = ownDirectClaudeLaunch({
    proc: { pid: 4242 },
    ownership,
    // The pid now answers for a process that started long before this spawn.
    readIdentity: async () => identity(Date.now() - 60_000),
  })

  const result = await launch.retire({ termGraceMs: 10, killVerifyMs: 10 })
  expect(result).toMatchObject({
    leader: "unknown",
    descendants: "unknown",
    error: { code: "ownership_unverified" },
  })
  expect(result.signals).toEqual([])
})

test("a launch whose identity matches the spawn is recorded and retirable", async () => {
  const ownership = volatileLaunchOwnership()
  const recorded: CreationIdentity[] = []
  const launch = ownDirectClaudeLaunch({
    proc: { pid: 4242 },
    ownership: {
      ...ownership,
      recordIdentity: async (launchId, observed) => {
        recorded.push(observed)
        await ownership.recordIdentity(launchId, observed)
      },
    },
    readIdentity: async () => identity(Date.now()),
  })

  const result = await launch.retire({ termGraceMs: 10, killVerifyMs: 10 })
  expect(recorded).toHaveLength(1)
  // The identity was established, so retirement reached a real verdict rather
  // than refusing for want of one.
  expect(result.error?.code).not.toBe("ownership_unverified")
})

test("Claude custom spawn forwards SDK process inputs but redacts observer metadata", () => {
  const sentinel = "observer-sentinel-secret"
  const descriptors: AgentProcessDescriptor[] = []
  const exits: unknown[] = []
  const observer: AgentProcessObserver = {
    register(descriptor) {
      descriptors.push(descriptor)
      return {
        update: () => undefined,
        exit: (event) => exits.push(event),
      }
    },
  }
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    pid: 321,
    kill: () => true,
  })
  const calls: unknown[] = []
  const signal = new AbortController().signal

  spawnObservedClaudeCodeProcess({
    options: {
      command: "/safe/bin/claude",
      args: ["--token", sentinel],
      cwd: "/safe/workspace",
      env: { SENTINEL_TOKEN: sentinel },
      signal,
    },
    observer,
    role: "harness",
    sessionId: "session-safe",
    mcp: {
      local: {
        name: "local",
        source: "user",
        transport: "stdio",
        command: "node",
        args: [sentinel],
        env: { TOKEN: sentinel },
      },
      remote: {
        name: "remote",
        source: "user",
        transport: "remote",
        url: "https://mcp.example",
        headers: { Authorization: sentinel },
      },
    },
    spawnProcess: ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options })
      return child
    }) as never,
  })

  expect(calls).toEqual([{
    command: "/safe/bin/claude",
    args: ["--token", sentinel],
    options: {
      cwd: "/safe/workspace",
      env: { SENTINEL_TOKEN: sentinel },
      signal,
      stdio: ["pipe", "pipe", "inherit"],
      // Its own POSIX group, so what the CLI starts is inside a scope this
      // owner can retire.
      detached: process.platform !== "win32",
    },
  }])
  expect(descriptors.map((descriptor) => [descriptor.role, descriptor.locality])).toEqual([
    ["harness", "local-process"],
    ["mcp", "local-process"],
    ["mcp", "remote"],
  ])
  expect(JSON.stringify(descriptors)).not.toContain(sentinel)
  child.emit("exit", 0, null)
  expect(exits).toHaveLength(3)
})
