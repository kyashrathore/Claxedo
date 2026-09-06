import path from "node:path"
import { config } from "../config"
import { object, readOptionalJsonFile, writePrivateJson } from "../json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asFiniteNumber } from "@claxedo/helpers/guards"

export type HostRecord = {
  workspaceId: string
  hostId: string
  directory: string
  displayName: string
  controlPlaneUrl: string
  appUrl: string
  relayUrl?: string
  runtimePort?: number
  pid?: number
  detached?: boolean
  updatedAt: number
}

function statePath() {
  return path.join(config().stateDir, "hosts.json")
}

function hostRecord(input: unknown): HostRecord | undefined {
  const row = object(input)
  const workspaceId = trimToUndefined(row.workspaceId)
  const hostId = trimToUndefined(row.hostId)
  const directory = trimToUndefined(row.directory)
  const displayName = trimToUndefined(row.displayName)
  const controlPlaneUrl = trimToUndefined(row.controlPlaneUrl)
  const appUrl = trimToUndefined(row.appUrl)
  if (!workspaceId || !hostId || !directory || !displayName || !controlPlaneUrl || !appUrl) return undefined
  return {
    workspaceId,
    hostId,
    directory,
    displayName,
    controlPlaneUrl,
    appUrl,
    ...(trimToUndefined(row.relayUrl) ? { relayUrl: trimToUndefined(row.relayUrl) } : {}),
    ...(asFiniteNumber(row.runtimePort) ? { runtimePort: asFiniteNumber(row.runtimePort) } : {}),
    ...(asFiniteNumber(row.pid) ? { pid: asFiniteNumber(row.pid) } : {}),
    ...(typeof row.detached === "boolean" ? { detached: row.detached } : {}),
    updatedAt: asFiniteNumber(row.updatedAt) ?? 0,
  }
}

export async function readHostState() {
  const raw = object(await readOptionalJsonFile(statePath()))
  const hosts = Array.isArray(raw.hosts) ? raw.hosts.map(hostRecord).filter((item) => !!item) : []
  return { hosts }
}

export async function writeHostState(records: HostRecord[]) {
  await writePrivateJson(statePath(), { hosts: records })
}

export async function upsertHostRecord(record: HostRecord) {
  const state = await readHostState()
  await writeHostState([
    ...state.hosts.filter((item) => item.workspaceId !== record.workspaceId && item.directory !== record.directory),
    record,
  ])
}

export async function removeHostRecord(input: { workspaceId?: string; directory?: string }) {
  const state = await readHostState()
  await writeHostState(
    state.hosts.filter(
      (item) =>
        !(
          (input.workspaceId && item.workspaceId === input.workspaceId) ||
          (input.directory && item.directory === input.directory)
        ),
    ),
  )
}
