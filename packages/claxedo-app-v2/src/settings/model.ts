import type { AppError } from "@/server"
import { machine, unreachable, type Transition } from "@/lib/machine"
import type { AccountsSnapshot } from "./accounts"

export type SettingsSectionId =
  | "accounts"
  | "machines"
  | "organization"
  | "appearance"
  | "keybindings"
  | "terminals"
  | "connections"
  | "sandbox"
  | "usage"

export type ColorScheme = "system" | "light" | "dark"

export type AppearancePreferences = {
  readonly uiFont: string
  readonly codeFont: string
  readonly terminalFont: string
  readonly terminalScreenReader: boolean
  readonly reasoningSummaries: boolean
  readonly shellToolPartsExpanded: boolean
  readonly editToolPartsExpanded: boolean
}

export const defaultAppearance: AppearancePreferences = {
  uiFont: "",
  codeFont: "",
  terminalFont: "",
  terminalScreenReader: false,
  reasoningSummaries: true,
  shellToolPartsExpanded: false,
  editToolPartsExpanded: true,
}

export type AccountsState =
  | { readonly kind: "idle" }
  | { readonly kind: "scanning"; readonly previous?: AccountsSnapshot }
  | { readonly kind: "ready"; readonly snapshot: AccountsSnapshot }
  | { readonly kind: "failed"; readonly error: AppError; readonly previous?: AccountsSnapshot }

export type AccountsEvent =
  | { readonly type: "scan" }
  | { readonly type: "scanned"; readonly snapshot: AccountsSnapshot }
  | { readonly type: "failed"; readonly error: AppError }

const previousOf = (state: AccountsState) =>
  state.kind === "ready" ? state.snapshot : state.kind === "idle" ? undefined : state.previous

export const accountsTransition: Transition<AccountsState, AccountsEvent> = (state, event) => {
  switch (event.type) {
    case "scan": {
      const previous = previousOf(state)
      return previous ? { kind: "scanning", previous } : { kind: "scanning" }
    }
    case "scanned":
      return { kind: "ready", snapshot: event.snapshot }
    case "failed": {
      const previous = previousOf(state)
      return previous ? { kind: "failed", error: event.error, previous } : { kind: "failed", error: event.error }
    }
    default:
      return unreachable(event)
  }
}

export const accountsMachine = () => machine<AccountsState, AccountsEvent>({ kind: "idle" }, accountsTransition)

export type AccountActivity = {
  readonly kind: "selecting" | "checking" | "removing" | "connecting"
  readonly key: string
}
