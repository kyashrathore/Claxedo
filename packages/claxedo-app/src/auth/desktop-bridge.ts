import { asRecord } from "@claxedo/helpers/guards"
import { readField, readString } from "@claxedo/helpers/readers"
import type { AuthUser } from "./display-user"
import type { HostedStreamBridge } from "@claxedo/account-contract"

export type DesktopAccountState =
  | { readonly kind: "unsigned" }
  | { readonly kind: "pending" }
  | { readonly kind: "signed"; readonly user: AuthUser; readonly identity: "resolving" | "known" | "failed" }
  | { readonly kind: "unavailable"; readonly reason: string }

export type DesktopAccountBridge = HostedStreamBridge & {
  readonly state: () => Promise<unknown>
  readonly onState: (listener: (state: unknown) => void) => () => void
  readonly signIn: () => Promise<unknown>
  readonly signOut: () => Promise<unknown>
  readonly run: (operation: string, input?: Readonly<Record<string, unknown>>) => Promise<unknown>
}

const MEMBERS = ["state", "onState", "signIn", "signOut", "run", "streamOpen", "streamStart", "streamClose", "onStreamChunk", "onStreamEnd", "onStreamError"] as const

function isBridge(value: Record<string, unknown> | undefined): value is Record<string, unknown> & DesktopAccountBridge {
  return value !== undefined && MEMBERS.every((member) => typeof value[member] === "function")
}

export function desktopAccountBridge(scope: unknown): DesktopAccountBridge | undefined {
  const bridge = asRecord(readField(readField(scope, "api"), "account"))
  return isBridge(bridge) ? bridge : undefined
}

function signedState(raw: unknown): DesktopAccountState {
  const identity = readField(raw, "identity")
  const id = readString(identity, "userId")
  if (!id) return { kind: "unavailable", reason: "The desktop account answered a signed state with no user" }
  const fullName = readString(identity, "displayName")
  const email = readString(identity, "email")
  const user: AuthUser = { id, ...(fullName ? { fullName } : {}), ...(email ? { email } : {}) }
  const known = fullName !== undefined || email !== undefined
  const lookup = readString(raw, "identityLookup") === "failed" ? "failed" : "resolving"
  return { kind: "signed", user, identity: known ? "known" : lookup }
}

export function desktopAccountState(raw: unknown): DesktopAccountState {
  switch (readString(raw, "status")) {
    case "unsigned":
      return { kind: "unsigned" }
    case "pending":
      return { kind: "pending" }
    case "signed":
      return signedState(raw)
    case "unavailable":
      return { kind: "unavailable", reason: readString(raw, "detail") ?? readString(raw, "reason") ?? "The desktop account is unavailable" }
    default:
      return { kind: "unavailable", reason: "The desktop account answered a state this app does not know" }
  }
}
