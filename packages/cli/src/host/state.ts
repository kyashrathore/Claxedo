import fs from "node:fs/promises"
import path from "node:path"
import { config } from "../config"
import { number, object, readJsonFile, text, writePrivateJson } from "../json"

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
  const workspaceId = text(row.workspaceId)
  const hostId = text(row.hostId)
  const directory = text(row.directory)
  const displayName = text(row.displayName)
  const controlPlaneUrl = text(row.controlPlaneUrl)
  const appUrl = text(row.appUrl)
  if (!workspaceId || !hostId || !directory || !displayName || !controlPlaneUrl || !appUrl) return
  return {
    workspaceId,
    hostId,
    directory,
    displayName,
    controlPlaneUrl,
    appUrl,
    ...(text(row.relayUrl) ? { relayUrl: text(row.relayUrl) } : {}),
    ...(number(row.runtimePort) ? { runtimePort: number(row.runtimePort) } : {}),
    ...(number(row.pid) ? { pid: number(row.pid) } : {}),
    ...(typeof row.detached === "boolean" ? { detached: row.detached } : {}),
    updatedAt: number(row.updatedAt) ?? 0,
  }
}

export async function readHostState() {
  const raw = object(await readJsonFile(statePath()))
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
    state.hosts.filter((item) =>
      (input.workspaceId && item.workspaceId === input.workspaceId) ||
      (input.directory && item.directory === input.directory)
        ? false
        : true,
    ),
  )
}

export async function ensureStateDir() {
  await fs.mkdir(config().stateDir, { recursive: true, mode: 0o700 })
}
