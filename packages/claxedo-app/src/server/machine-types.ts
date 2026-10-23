import type { MachineId, UserId } from "./ids"
import type { AppError } from "./types"

export type MachineEnrollment = {
  readonly hostId: string
  readonly lastSeenAt: number
  readonly servingWorkspaceIds: readonly string[]
}

export type Machine = {
  readonly id?: MachineId
  readonly name: string
  readonly ownerId?: UserId
  readonly online: boolean
  readonly paused?: boolean
  readonly isThisMachine: boolean
  readonly enrolled: boolean
  readonly enrollment?: MachineEnrollment
}

export type ServingMachine = { readonly id?: MachineId; readonly name: string }

export type MachineProbe =
  | { readonly kind: "answered" }
  | { readonly kind: "unhealthy"; readonly status: string }
  | { readonly kind: "unreachable"; readonly error: AppError }
  | { readonly kind: "servesNothing" }

export type PairingStage = "waiting" | "installing" | "awaitingApproval" | "approved" | "connected" | "ready" | "denied" | "expired"

export type PairingFolderKind = "home" | "root" | "folder"

export type PairingMachine = {
  readonly hostname: string
  readonly os: string
  readonly arch: string
  readonly folder: string
  readonly folderKind: PairingFolderKind
  readonly country?: string
}

export type Pairing = {
  readonly id: string
  readonly stage: PairingStage
  readonly expiresAt: number
  readonly askedAt?: number
  readonly request?: "machine" | "folder"
  readonly machine?: PairingMachine
  readonly installingOn?: { readonly hostname: string; readonly os: string }
  readonly hostId?: string
  readonly name?: string
  readonly workspaceId?: string
}

export type ConnectCommands = { readonly posix: string; readonly windows: string }

export type MintedPairing = { readonly id: string; readonly code: string; readonly expiresAt: number; readonly commands: ConnectCommands }

export type ServerConnectCommands = ConnectCommands & { readonly cloudInit: string }

export type MintedInvitation = { readonly id: string; readonly expiresAt: number; readonly commands: ServerConnectCommands }
