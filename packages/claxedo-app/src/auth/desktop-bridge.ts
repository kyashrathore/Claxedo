import { asRecord } from "@claxedo/helpers/guards"
import { readBoolean, readField, readString } from "@claxedo/helpers/readers"
import type { AccountStreamPort } from "@/server"
import type { AuthUser } from "./display-user"

export type DesktopAccountState =
  | { readonly kind: "unsigned" }
  | { readonly kind: "signInUnfinished" }
  | { readonly kind: "loading" }
  | { readonly kind: "awaitingBrowser" }
  | { readonly kind: "signed"; readonly user: AuthUser; readonly identity: "resolving" | "known" | "failed" }
  | { readonly kind: "revoked" }
  | { readonly kind: "unavailable"; readonly reason: string }

export type DesktopAccountBridge = AccountStreamPort & {
  readonly state: () => Promise<unknown>
  readonly onState: (listener: (state: unknown) => void) => () => void
  readonly signIn: () => Promise<unknown>
  readonly signOut: () => Promise<unknown>
  readonly cancelSignIn: () => Promise<unknown>
  readonly run: (operation: string, input?: Readonly<Record<string, unknown>>) => Promise<unknown>
}

const MEMBERS = ["state", "onState", "signIn", "signOut", "cancelSignIn", "run", "streamOpen", "streamStart", "streamClose", "onStreamChunk", "onStreamEnd", "onStreamError"] as const

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
  const lookupFailed = readString(raw, "identityLookup") === "failed"
  if (id === "" && !lookupFailed) return { kind: "loading" }
  if (!id) return { kind: "unavailable", reason: "The desktop account is signed in but could not read who is signed in" }
  const fullName = readString(identity, "displayName")
  const email = readString(identity, "email")
  const orgId = readString(identity, "orgId")
  const user: AuthUser = { id, ...(fullName ? { fullName } : {}), ...(email ? { email } : {}), ...(orgId ? { orgId } : {}) }
  const known = fullName !== undefined || email !== undefined
  return { kind: "signed", user, identity: known ? "known" : lookupFailed ? "failed" : "resolving" }
}

export function desktopAccountState(raw: unknown): DesktopAccountState {
  switch (readString(raw, "status")) {
    case "unsigned":
      return readBoolean(raw, "signInUnfinished") ? { kind: "signInUnfinished" } : { kind: "unsigned" }
    case "pending":
      return { kind: "awaitingBrowser" }
    case "signed":
      return signedState(raw)
    case "unavailable":
      if (readString(raw, "reason") === "revoked") return { kind: "revoked" }
      return { kind: "unavailable", reason: readString(raw, "detail") ?? readString(raw, "reason") ?? "The desktop account is unavailable" }
    default:
      return { kind: "unavailable", reason: "The desktop account answered a state this app does not know" }
  }
}
