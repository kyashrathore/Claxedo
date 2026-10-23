import { machine as stateMachine, unreachable, type Transition } from "@/lib/machine"
import { toAppError, type AppError, type MachinesApi, type MintedPairing, type Pairing, type PairingStage } from "@/server"
import { getFilename } from "@/ui/utils"
import type { SettingsKey } from "./i18n"

export type ConnectCode =
  | { readonly kind: "minting"; readonly attempt: number }
  | { readonly kind: "minted"; readonly attempt: number; readonly minted: MintedPairing }
  | { readonly kind: "failed"; readonly attempt: number; readonly error: AppError }

export type ConnectCodeEvent =
  | { readonly type: "remint" }
  | { readonly type: "minted"; readonly attempt: number; readonly minted: MintedPairing }
  | { readonly type: "failed"; readonly attempt: number; readonly error: AppError }

export const connectCodeTransition: Transition<ConnectCode, ConnectCodeEvent> = (state, event) => {
  switch (event.type) {
    case "remint":
      return { kind: "minting", attempt: state.attempt + 1 }
    case "minted":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "minted", attempt: state.attempt, minted: event.minted } : state
    case "failed":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "failed", attempt: state.attempt, error: event.error } : state
    default:
      return unreachable(event)
  }
}

export function createConnectCode(api: Pick<MachinesApi, "pair">) {
  const code = stateMachine<ConnectCode, ConnectCodeEvent>({ kind: "minting", attempt: 1 }, connectCodeTransition)
  const mint = async () => {
    const { attempt } = code.state()
    try {
      code.send({ type: "minted", attempt, minted: await api.pair() })
    } catch (error) {
      code.send({ type: "failed", attempt, error: toAppError(error) })
    }
  }
  void mint()
  return {
    state: code.state,
    remint: () => {
      code.send({ type: "remint" })
      void mint()
    },
  }
}

export type CommandPlatform = "posix" | "windows"

export function guessedPlatform(platform: string): CommandPlatform {
  return /^win/i.test(platform) ? "windows" : "posix"
}

export function codeExpired(minted: MintedPairing, pairing: Pairing | undefined, now: number): boolean {
  if (pairing?.stage === "expired") return true
  return pairing?.request === undefined && minted.expiresAt <= now
}

export function codeTimeLeft(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

const STAGE_LINE = {
  waiting: "settings.machines.pairing.waiting",
  installing: "settings.machines.pairing.installing",
  awaitingApproval: "settings.machines.pairing.awaiting",
  approved: "settings.machines.pairing.approved",
  connected: "settings.machines.pairing.connected",
  ready: "settings.machines.pairing.ready",
  denied: "settings.machines.pairing.denied",
  expired: "settings.machines.pairing.unanswered",
} as const satisfies Record<PairingStage, SettingsKey>

export function stageLineKey(stage: PairingStage): SettingsKey {
  return STAGE_LINE[stage]
}

export function stageLineValues(pairing: Pairing): Record<string, string> {
  const machineName = pairing.name ?? pairing.machine?.hostname ?? pairing.installingOn?.hostname ?? ""
  return { name: machineName, folder: pairing.machine ? getFilename(pairing.machine.folder) || pairing.machine.folder : "" }
}
