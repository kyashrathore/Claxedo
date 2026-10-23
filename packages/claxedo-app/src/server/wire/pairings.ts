import { isFiniteNumber, isNonBlankString, isRecord } from "@claxedo/helpers/guards"
import type { MintedPairing, Pairing, PairingFolderKind, PairingMachine, PairingStage } from "../machine-types"

const STAGES: Readonly<Record<string, PairingStage>> = {
  waiting: "waiting",
  installing: "installing",
  awaiting_approval: "awaitingApproval",
  approved: "approved",
  connected: "connected",
  ready: "ready",
  denied: "denied",
  expired: "expired",
}

function stageFromWire(value: unknown): PairingStage | undefined {
  return typeof value === "string" && Object.hasOwn(STAGES, value) ? STAGES[value] : undefined
}

function folderKindFromWire(value: unknown): PairingFolderKind {
  return value === "home" || value === "root" ? value : "folder"
}

function machineFromWire(value: unknown): PairingMachine | undefined {
  if (!isRecord(value) || !isNonBlankString(value.hostname) || !isNonBlankString(value.folder)) return undefined
  return {
    hostname: value.hostname,
    os: typeof value.os === "string" ? value.os : "",
    arch: typeof value.arch === "string" ? value.arch : "",
    folder: value.folder,
    folderKind: folderKindFromWire(value.folder_kind),
    ...(isNonBlankString(value.country) ? { country: value.country } : {}),
  }
}

function installingFromWire(value: unknown): Pairing["installingOn"] {
  return isRecord(value) && value.stage === "installing" && typeof value.hostname === "string" && typeof value.os === "string" ? { hostname: value.hostname, os: value.os } : undefined
}

export function pairingFromWire(raw: unknown): Pairing | undefined {
  if (!isRecord(raw) || !isNonBlankString(raw.pairing_id) || !isFiniteNumber(raw.expires_at)) return undefined
  const stage = stageFromWire(raw.stage)
  if (!stage) return undefined
  const machine = machineFromWire(raw.machine)
  const installingOn = installingFromWire(raw.progress)
  return {
    id: raw.pairing_id,
    stage,
    expiresAt: raw.expires_at,
    ...(isFiniteNumber(raw.asked_at) ? { askedAt: raw.asked_at } : {}),
    ...(raw.request === "machine" || raw.request === "folder" ? { request: raw.request } : {}),
    ...(machine ? { machine } : {}),
    ...(installingOn ? { installingOn } : {}),
    ...(isNonBlankString(raw.host_id) ? { hostId: raw.host_id } : {}),
    ...(isNonBlankString(raw.display_name) ? { name: raw.display_name } : {}),
    ...(isNonBlankString(raw.workspace_id) ? { workspaceId: raw.workspace_id } : {}),
  }
}

export function pairingRequestsFromWire(rows: readonly unknown[]): Pairing[] {
  return rows.flatMap((row) => {
    const pairing = pairingFromWire(row)
    if (pairing) return [pairing]
    console.error("The pairing requests list sent a row this app cannot read", { row })
    return []
  })
}

export function mintedPairingFromWire(raw: unknown): MintedPairing | undefined {
  if (!isRecord(raw) || !isNonBlankString(raw.pairing_id) || !isNonBlankString(raw.code) || !isFiniteNumber(raw.expires_at)) return undefined
  const commands = raw.commands
  if (!isRecord(commands) || !isNonBlankString(commands.posix) || !isNonBlankString(commands.windows)) return undefined
  return { id: raw.pairing_id, code: raw.code, expiresAt: raw.expires_at, commands: { posix: commands.posix, windows: commands.windows } }
}
