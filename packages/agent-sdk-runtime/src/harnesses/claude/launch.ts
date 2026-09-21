import { randomUUID } from "crypto"
import { spawn } from "child_process"
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk"
import { observeAgentProcess, type AgentProcessObserver, type AgentProcessObserverHandle } from "../../process-observer"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { errorMessage } from "../shared/sdk-runtime-values"
import {
  readCreationIdentity,
  retire,
  volatileLaunchOwnership,
  type LaunchOwnershipStore,
  type RetirementBudgets,
  type RetirementResult,
} from "../../launch"

export function spawnObservedClaudeCodeProcess(input: {
  options: SpawnOptions
  observer?: AgentProcessObserver
  role: "harness" | "probe"
  sessionId?: string
  mcp?: Record<string, ResolvedMcpServer>
  spawnProcess?: typeof spawn
  /** Called with the launch this spawn owns, so the turn can retire it. */
  onLaunch?: (launch: ClaudeDirectLaunch) => void
  ownership?: LaunchOwnershipStore
  /** The workspace a later owner reconciles this launch under; empty when none was named. */
  workspaceId?: string
}): SpawnedProcess {
  const proc = (input.spawnProcess ?? spawn)(
    input.options.command,
    input.options.args,
    {
      ...(input.options.cwd ? { cwd: input.options.cwd } : {}),
      env: input.options.env,
      signal: input.options.signal,
      stdio: ["pipe", "pipe", "inherit"],
      // Its own POSIX group, so what the CLI starts stays inside a scope this
      // owner can retire. The SDK closes stdin first and only then aborts, so
      // detaching does not cost the child its graceful shutdown.
      detached: process.platform !== "win32",
    },
  )
  input.onLaunch?.(ownDirectClaudeLaunch({
    proc,
    ownership: input.ownership ?? volatileLaunchOwnership(),
    workspaceId: input.workspaceId ?? "",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.options.cwd ? { directory: input.options.cwd } : {}),
  }))
  const ownerId = `claude-${input.role}:${randomUUID()}`
  const handles = [
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "claude",
      access: "native",
      role: input.role,
      label: input.role === "probe" ? "Claude model probe" : "Claude Code",
      locality: "local-process",
      confidence: proc.pid ? "direct" : "inferred",
      capabilities: {
        resourceMetrics: "process",
        ownerActions: false,
      },
      ...(proc.pid ? { pid: proc.pid } : {}),
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      executableBasename: input.options.command.split(/[\\/]/).at(-1) || "claude",
    }),
    ...Object.values(input.mcp ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `claude-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "claude",
      access: "native",
      role: "mcp" as const,
      label: `MCP ${server.name}`,
      locality: server.transport === "stdio" ? "local-process" as const : "remote" as const,
      confidence: server.transport === "stdio" ? "inferred" as const : "not-process-backed" as const,
      capabilities: {
        resourceMetrics: server.transport === "stdio" ? "process" as const : "none" as const,
        ownerActions: false,
      },
      parentOwnerId: ownerId,
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      mcpName: server.name,
      transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
      ...(server.transport === "stdio"
        ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
        : {}),
    })),
  ]
  let exited = false
  const exit = (event: Parameters<AgentProcessObserverHandle["exit"]>[0]) => {
    if (exited) return
    exited = true
    handles.forEach((handle) => handle.exit(event))
  }
  proc.once("exit", (code) => exit({
    reason: "exited",
    ...(code !== null ? { exitCode: code } : {}),
  }))
  proc.once("error", () => exit({ reason: "error" }))
  handles.forEach((handle) => handle.update({ lifecycle: "ready" }))
  return proc
}

/**
 * `startedAtMs` has one-second resolution on every platform reachable without
 * a native addon, so a process started in the same second as the spawn reads
 * as marginally earlier than the clock this launcher sampled.
 */
const IDENTITY_START_TOLERANCE_MS = 1_000

export type ClaudeDirectLaunch = {
  retire(budgets: RetirementBudgets): Promise<RetirementResult>
}

/**
 * The Claude Code SDK's spawn hook is synchronous, so this launch cannot use
 * the gate: there is no moment at which the host could authorize execution
 * before the payload runs. It is recorded as a `direct` launch, whose identity
 * is read after the spawn — a prepared row alone can therefore never prove the
 * process did not start, and `reconcileLaunch` says exactly that.
 */
function ownDirectClaudeLaunch(input: {
  /** Only the pid is read: `SpawnedProcess` does not carry one, but every local spawn does. */
  proc: { pid?: number }
  ownership: LaunchOwnershipStore
  workspaceId: string
  sessionId?: string
  directory?: string
}): ClaudeDirectLaunch {
  const spawnedAt = Date.now()
  const recorded = (async () => {
    const prepared = await input.ownership.prepare({
      role: "harness",
      protocol: "direct",
      scope: {
        workspaceId: input.workspaceId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
      },
    })
    // Read after the spawn, so the pid may already have been recycled. The
    // recorded start instant is what rules that out: a process that began
    // before this launcher called spawn is not the one it started, and
    // retiring it would signal a stranger.
    const observed = input.proc.pid ? await readCreationIdentity(input.proc.pid) : undefined
    const identity = observed && observed.startedAtMs >= spawnedAt - IDENTITY_START_TOLERANCE_MS ? observed : undefined
    if (identity) await input.ownership.recordIdentity(prepared.launchId, identity)
    return { launchId: prepared.launchId, identity }
  })()
  // Nothing awaits the record until a retirement asks for it, and an
  // unobserved rejection here would take the process down.
  void recorded.catch(() => {})
  return {
    async retire(budgets: RetirementBudgets) {
      let launch: Awaited<typeof recorded>
      try {
        launch = await recorded
      } catch (error) {
        return unownedClaudeLaunch(`this Claude launch was never recorded: ${errorMessage(error)}`)
      }
      if (!launch.identity) {
        return unownedClaudeLaunch(`no creation identity was established for pid ${String(input.proc.pid)}, so its group was not signalled`)
      }
      const result = await retire({ identity: launch.identity }, budgets)
      await input.ownership.recordRetirement(launch.launchId, result)
      return result
    },
  }
}

function unownedClaudeLaunch(message: string): RetirementResult {
  return {
    leader: "unknown",
    descendants: "unknown",
    signals: [],
    error: { code: "ownership_unverified", message },
  }
}

