import type { AppError, OrgId, OrgRole, SessionRef, UserId } from "@/server"
import { machine, unreachable, type Transition } from "@/lib/machine"

export type ShareLevel = "follow" | "send"

export type ShareRecipient =
  | { readonly kind: "user"; readonly userId: UserId; readonly label?: string }
  | { readonly kind: "org"; readonly orgId: OrgId }

export type ShareInvitee = { readonly kind: "identifier"; readonly identifier: string }

export type SessionShare = {
  readonly id: string
  readonly level: ShareLevel
  readonly to: ShareRecipient
}

export type SessionParticipant = { readonly userId: UserId; readonly label?: string }

export type SessionShares = {
  readonly canManageShares: boolean
  readonly shares: readonly SessionShare[]
  readonly participants: readonly SessionParticipant[]
}

export type SessionCapabilities = { readonly prompt: boolean }

export type ShareRequest = {
  readonly ref: SessionRef
  readonly level: ShareLevel
  readonly to: ShareRecipient | ShareInvitee
  readonly description: string
}

export type OrgMember = {
  readonly userId: UserId
  readonly label: string
  readonly email?: string
  readonly role: OrgRole
}

export type OrgMembers =
  | { readonly kind: "listed"; readonly members: readonly OrgMember[] }
  | { readonly kind: "unavailable" }

export type ShareFormState =
  | { readonly kind: "idle" }
  | { readonly kind: "confirmingSend"; readonly request: ShareRequest; readonly acknowledged: boolean }
  | { readonly kind: "granting"; readonly request: ShareRequest }
  | { readonly kind: "revoking"; readonly shareId: string }
  | { readonly kind: "failed"; readonly error: AppError }

export type ShareFormEvent =
  | { readonly type: "share"; readonly request: ShareRequest }
  | { readonly type: "acknowledge"; readonly acknowledged: boolean }
  | { readonly type: "confirm" }
  | { readonly type: "revoke"; readonly shareId: string }
  | { readonly type: "settled" }
  | { readonly type: "failed"; readonly error: AppError }
  | { readonly type: "cancel" }

export const shareFormTransition: Transition<ShareFormState, ShareFormEvent> = (state, event) => {
  switch (event.type) {
    case "share":
      return event.request.level === "send"
        ? { kind: "confirmingSend", request: event.request, acknowledged: false }
        : { kind: "granting", request: event.request }
    case "acknowledge":
      return state.kind === "confirmingSend" ? { ...state, acknowledged: event.acknowledged } : state
    case "confirm":
      return state.kind === "confirmingSend" && state.acknowledged ? { kind: "granting", request: state.request } : state
    case "revoke":
      return { kind: "revoking", shareId: event.shareId }
    case "settled":
      return { kind: "idle" }
    case "failed":
      return { kind: "failed", error: event.error }
    case "cancel":
      return { kind: "idle" }
    default:
      return unreachable(event)
  }
}

export const shareForm = () => machine<ShareFormState, ShareFormEvent>({ kind: "idle" }, shareFormTransition)

export const isOrgManager = (role: OrgRole | undefined) => role === "owner" || role === "admin"
