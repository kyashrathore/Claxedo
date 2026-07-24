import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { PassThrough } from "stream"

import {
  observeAgentProcess,
  safeAgentProcessDescriptor,
  type AgentProcessDescriptor,
  type AgentProcessObserver,
} from "./process-observer"
import { spawnObservedClaudeCodeProcess } from "./harnesses/claude/driver"

const direct = {
  ownerId: "harness-1",
  launchId: "launch-1",
  harnessId: "codex",
  access: "native",
  role: "harness",
  label: "Codex app server",
  locality: "local-process",
  confidence: "direct",
  capabilities: {
    resourceMetrics: "process",
    ownerActions: false,
  },
  pid: 42,
  directory: "/tmp/workspace",
  sessionId: "session-1",
  executableBasename: "codex",
} satisfies AgentProcessDescriptor

describe("agent process observer", () => {
  test("publishes only the explicitly safe process descriptor", () => {
    const seen: AgentProcessDescriptor[] = []
    const observer: AgentProcessObserver = {
      register(descriptor) {
        seen.push(descriptor)
        return { update: () => undefined, exit: () => undefined }
      },
    }

    observeAgentProcess(observer, {
      ...direct,
      label: "Codex\u0000 app server",
    })

    expect(seen).toEqual([{
      ...direct,
      label: "Codex  app server",
    }])
    const serialized = JSON.stringify(seen)
    for (const forbidden of ["argv", "command", "env", "header", "prompt", "credential"]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test("fails invalid action, PID, and executable capabilities closed", () => {
    expect(() => safeAgentProcessDescriptor({
      ...direct,
      pid: undefined,
      confidence: "inferred",
      capabilities: { resourceMetrics: "process", ownerActions: true },
    })).toThrow()
    expect(() => safeAgentProcessDescriptor({
      ...direct,
      pid: 0,
    })).toThrow()
    expect(() => safeAgentProcessDescriptor({
      ...direct,
      executableBasename: "/tmp/codex",
    })).toThrow()
  })

  test("observer failures never alter the harness lifecycle", () => {
    const handle = observeAgentProcess({
      register() {
        throw new Error("diagnostics unavailable")
      },
    }, direct)

    expect(() => handle.update({ lifecycle: "ready" })).not.toThrow()
    expect(() => handle.exit({ reason: "exited", exitCode: 0 })).not.toThrow()
  })

  test("sentinel secrets cannot enter through command-shaped fields", () => {
    const sentinel = "observer-sentinel-secret"
    const descriptor = safeAgentProcessDescriptor({
      ...direct,
      ownerId: "harness-safe",
      launchId: "launch-safe",
      label: "Codex app server",
      directory: "/safe/workspace",
    })
    expect(JSON.stringify(descriptor)).not.toContain(sentinel)
    for (const key of ["command", "args", "argv", "env", "headers", "prompt", "config"]) {
      expect(Object.keys(descriptor)).not.toContain(key)
    }
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
})
