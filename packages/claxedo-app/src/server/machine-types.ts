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
