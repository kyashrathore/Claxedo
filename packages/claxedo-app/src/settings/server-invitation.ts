import { hostPathKind } from "@claxedo/account-contract/host-path"
import { machine as stateMachine, unreachable, type Transition } from "@/lib/machine"
import { toAppError, type AppError, type MachinesApi, type MintedInvitation, type ServerInvitation } from "@/server"

export type ServerCommand =
  | { readonly kind: "editing"; readonly attempt: number }
  | { readonly kind: "minting"; readonly attempt: number }
  | { readonly kind: "minted"; readonly attempt: number; readonly invitation: MintedInvitation }
  | { readonly kind: "failed"; readonly attempt: number; readonly error: AppError }

export type ServerCommandEvent =
  | { readonly type: "mint" }
  | { readonly type: "edited" }
  | { readonly type: "minted"; readonly attempt: number; readonly invitation: MintedInvitation }
  | { readonly type: "failed"; readonly attempt: number; readonly error: AppError }

export const serverCommandTransition: Transition<ServerCommand, ServerCommandEvent> = (state, event) => {
  switch (event.type) {
    case "mint":
      return state.kind === "minting" ? state : { kind: "minting", attempt: state.attempt + 1 }
    case "edited":
      return state.kind === "editing" ? state : { kind: "editing", attempt: state.attempt + 1 }
    case "minted":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "minted", attempt: state.attempt, invitation: event.invitation } : state
    case "failed":
      return state.kind === "minting" && event.attempt === state.attempt ? { kind: "failed", attempt: state.attempt, error: event.error } : state
    default:
      return unreachable(event)
  }
}

export function isServerFolder(folder: string): boolean {
  return hostPathKind(folder.trim()) !== undefined
}

export function createServerCommand(api: Pick<MachinesApi, "invite">) {
  const command = stateMachine<ServerCommand, ServerCommandEvent>({ kind: "editing", attempt: 0 }, serverCommandTransition)
  const mint = async (server: ServerInvitation) => {
    if (command.state().kind === "minting") return
    command.send({ type: "mint" })
    const { attempt } = command.state()
    try {
      command.send({ type: "minted", attempt, invitation: await api.invite({ name: server.name.trim(), folder: server.folder.trim() }) })
    } catch (error) {
      command.send({ type: "failed", attempt, error: toAppError(error) })
    }
  }
  return { state: command.state, mint, edited: () => command.send({ type: "edited" }) }
}
