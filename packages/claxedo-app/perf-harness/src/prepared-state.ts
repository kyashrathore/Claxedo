import { constants as fsConstants } from "node:fs"
import { cp, mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { launchClaxedo } from "./launch"
import { materializeCorpus, type MaterializedCorpus, type MaterializeInput } from "./materialize"
import type { PackagedApp } from "./packaged-app"
import { readPreparedCache, writePreparedCache } from "./prepared-cache"
import { chooseActivityView } from "./rail"

export type PreparedState = { materialization: MaterializedCorpus; privateRoot: string; stateHandles: { P0: string; P1: string } }

export type PrepareInput = Omit<MaterializeInput, "stateRoot" | "workspaceRoot"> & {
  runDirectory: string
  buildDigestSha256: string
}

export function copyState(from: string, to: string) {
  return cp(from, to, { recursive: true, errorOnExist: true, force: false, mode: fsConstants.COPYFILE_FICLONE })
}

export function controlScope(materialization: MaterializedCorpus) {
  const control = requireTarget(materialization, "control")
  return { projectId: materialization.projects.get(control.workspaceId) }
}

export function requireTarget(materialization: MaterializedCorpus, logicalSessionId: string) {
  const target = materialization.targets.get(logicalSessionId)
  if (!target) throw new Error(`Claxedo has no materialized target for ${logicalSessionId}`)
  return target
}

async function seedInitializedState(app: PackagedApp, materialization: MaterializedCorpus, p0: string, p1: string, log: (line: string) => void) {
  await rm(p1, { recursive: true, force: true })
  await copyState(p0, p1)
  const launch = await launchClaxedo({ app, stateRoot: p1, control: requireTarget(materialization, "control"), controlScope: controlScope(materialization), log })
  const viewChoice = await chooseActivityView(launch.page, 30_000).then(
    () => ({ failed: false as const }),
    (error: unknown) => ({ failed: true as const, error }),
  )
  const closed = await launch.shutdown()
  if (closed.survivors.length > 0) throw new Error("Claxedo's P1 initialization left a surviving process")
  if (viewChoice.failed) throw viewChoice.error
}

export async function prepareState(input: PrepareInput): Promise<PreparedState> {
  const stateCache = process.env.AGENT_APP_BENCHMARK_STATE_CACHE
  const privateRoot = path.join(await realpath(path.resolve(input.runDirectory)), "driver-state", "claxedo")
  const stateRoot = stateCache ? path.join(await realpath(stateCache), "claxedo") : privateRoot
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const stateHandles = { P0: path.join(stateRoot, "P0"), P1: path.join(stateRoot, "P1") }
  const identity = { corpusDigestSha256: input.expectedCorpusDigestSha256, buildDigestSha256: input.buildDigestSha256 }
  const cached = stateCache ? await readPreparedCache(stateRoot, identity) : undefined
  if (cached) return { materialization: cached, privateRoot, stateHandles }
  const materialization = await materializeCorpus({ ...input, stateRoot: stateHandles.P0, workspaceRoot: path.join(stateRoot, "workspaces") })
  await seedInitializedState(input.app, materialization, stateHandles.P0, stateHandles.P1, input.log)
  if (stateCache) await writePreparedCache(stateRoot, identity, materialization)
  return { materialization, privateRoot, stateHandles }
}
