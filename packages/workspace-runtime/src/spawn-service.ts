import type { HarnessServices, OwnedProcess, SpawnCommand, SpawnOptions } from "@claxedo/harness/contract"
import { launchOwnedProcess, retirementSettled, type LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { harnessSpawnEnv } from "@claxedo/process-ownership/spawn-env"
import { singleFlightUntil } from "@claxedo/helpers"
import { DEFAULT_RECOVERY_BUDGETS } from "@claxedo/agent-runtime-contract"
import type { ProcessObserver } from "./managed-processes/process-observer"

export type SpawnObservation = { observer: ProcessObserver; workspaceId?: string }

type Launched = Awaited<ReturnType<typeof launchOwnedProcess>>

function observeSpawn(observation: SpawnObservation, launch: Launched, command: SpawnCommand, options: SpawnOptions, pid: number) {
  return observation.observer.register({
    ownerId: launch.launchId, ownerGeneration: launch.launchId, launchId: launch.launchId,
    kind: options.role, role: options.role, label: options.label, pid,
    ...(observation.workspaceId ? { workspaceId: observation.workspaceId } : {}),
    directory: command.cwd,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    access: "local", attributionConfidence: "direct",
  }, {
    stopGracefully: () => launch.retire({ termGraceMs: DEFAULT_RECOVERY_BUDGETS.termGraceMs, killVerifyMs: DEFAULT_RECOVERY_BUDGETS.killVerifyMs }),
    killOwnedTree: () => launch.retire({ termGraceMs: 0, killVerifyMs: DEFAULT_RECOVERY_BUDGETS.killVerifyMs }),
  })
}

export function createSpawnService(ownership: LaunchOwnershipStore, observation?: SpawnObservation): HarnessServices["spawn"] {
  return async (command: SpawnCommand, options: SpawnOptions): Promise<OwnedProcess> => {
    if (options.signal.aborted) throw new Error(`Spawn of ${options.label} was aborted before it started`)
    const launch = await launchOwnedProcess({
      ownership,
      role: "harness",
      ...(options.sessionId ? { scope: { sessionId: options.sessionId, directory: command.cwd } } : { scope: { directory: command.cwd } }),
      payload: { command: command.file, args: [...command.args] },
      cwd: command.cwd,
      env: harnessSpawnEnv(command.env),
    })
    const { child } = launch
    if (options.signal.aborted) {
      await launch.retire({ termGraceMs: 1_000, killVerifyMs: 1_000 })
      throw new Error(`Spawn of ${options.label} was aborted before its process was handed back`)
    }
    if (!child.stdin || !child.stdout || !child.stderr || launch.payloadPid === undefined) {
      await launch.retire({ termGraceMs: 1_000, killVerifyMs: 1_000 })
      throw new Error(`Launch ${launch.launchId} has no payload process or standard streams`)
    }
    const exited: OwnedProcess["exited"] = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : new Promise((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }))
        })
    let observed: ReturnType<typeof observeSpawn> | undefined
    try {
      observed = observation && observeSpawn(observation, launch, command, options, launch.payloadPid)
      observed?.update({ pid: launch.payloadPid, lifecycle: "ready" })
    } catch (error) {
      await launch.retire({ termGraceMs: 1_000, killVerifyMs: 1_000 })
      throw error
    }
    if (observed) void exited.then((status) => observed.exit({ reason: "exited", ...(status.code === null ? {} : { exitCode: status.code }) }))
    return {
      pid: launch.payloadPid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      retire: singleFlightUntil(async (deadline: Parameters<OwnedProcess["retire"]>[0]): Promise<Awaited<ReturnType<OwnedProcess["retire"]>>> => {
        const remainingMs = deadline.at - Date.now()
        if (deadline.signal.aborted || remainingMs <= 0) {
          return { stopped: false, error: { code: "deadline_exceeded", message: "Process retirement deadline has expired" } }
        }
        const termGraceMs = Math.max(1, Math.floor(remainingMs / 2))
        const result = await launch.retire({ termGraceMs, killVerifyMs: Math.max(1, remainingMs - termGraceMs) })
        if (retirementSettled(result)) return { stopped: true }
        return { stopped: false, error: result.error ?? { code: "retirement_unverified", message: `Launch ${launch.launchId} retirement was not verified` } }
      }, (result) => result.stopped),
    }
  }
}
