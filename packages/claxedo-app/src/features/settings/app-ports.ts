import type * as Providers from "@/app/providers/use-providers"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as QueryOptions from "@/app/integrations/sync/query-options"
import type * as ConnectProvider from "@/app/dialogs/connect-provider"
import type * as SelectProvider from "@/app/dialogs/select-provider"
import type * as CustomProvider from "@/app/dialogs/custom-provider"
import type * as AIConnectApi from "@/features/onboarding/ai-connect-api"
import type * as AIConnectState from "@/features/onboarding/ai-connect-state"
import type * as TerminalAgents from "@/features/terminal/core/terminal-agents"
import type * as TerminalCommands from "@/features/terminal/core/terminal-commands"
import type * as Models from "@/features/session/providers/models"
import type * as HarnessModelOptions from "@/features/session/harness/harness-model-options"
import type * as Command from "@/app/providers/command"
import type * as ConnectIntegration from "@/app/dialogs/connect-integration"
import type * as ProviderConnectFormModule from "@/app/dialogs/provider-connect-form"
import type * as LinkModule from "@/app/controls/link"
import type * as SDK from "@/app/providers/sdk/sdk"

export type MachineLogin = AIConnectState.MachineLogin
export type LocalHarnessCheck = (typeof AIConnectState.localHarnessChecks)[number]
export type TerminalAgentId = TerminalAgents.TerminalAgentId
export type TerminalCustomCommand = TerminalCommands.CustomCommand

export type SettingsAppPorts = {
  useProviders: typeof Providers.useProviders
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  useShellQueryOptions: typeof QueryOptions.useShellQueryOptions
  DialogConnectProvider: typeof ConnectProvider.DialogConnectProvider
  DialogSelectProvider: typeof SelectProvider.DialogSelectProvider
  DialogCustomProvider: typeof CustomProvider.DialogCustomProvider
  verifyAIConnection: typeof AIConnectApi.verifyAIConnection
  /** What each harness on the server's machine says about the login it would run on. */
  loadMachineLogins: typeof AIConnectApi.loadMachineLogins
  /** Withdraws the stored mark, so a harness runs on the login its own CLI holds. */
  useMachineLogin: typeof AIConnectApi.useMachineLogin
  /** The harness rows the Agents section lists, in the order onboarding declares them. */
  localHarnessChecks: typeof AIConnectState.localHarnessChecks
  /** The CLI agents the Terminals pane edits a command for, in catalog order. */
  terminalAgents: typeof TerminalAgents.TERMINAL_AGENTS
  getTerminalCommands: typeof TerminalCommands.getTerminalCommands
  saveTerminalCommands: typeof TerminalCommands.saveTerminalCommands
  defaultTerminalCommands: typeof TerminalCommands.defaultTerminalCommands
  useModelVisibility: typeof Models.useModelVisibility
  /** The models a harness reports for a workspace, over the composer's own transport. */
  loadHarnessModelOptions: typeof HarnessModelOptions.loadHarnessModelOptions
  groupHarnessModels: typeof HarnessModelOptions.groupHarnessModels
  formatKeybind: typeof Command.formatKeybind
  parseKeybind: typeof Command.parseKeybind
  useCommand: typeof Command.useCommand
  DialogConnectIntegration: typeof ConnectIntegration.DialogConnectIntegration
  ProviderConnectForm: typeof ProviderConnectFormModule.ProviderConnectForm
  Link: typeof LinkModule.Link
  useSandboxOnboardingFunnel: () => {
    emit(event: { name: "sandbox_provider_configured"; provider: string }): void
  }
  useSDK: typeof SDK.useSDK
  /** The operator ACP connections the picker offers alongside the built-in harnesses. */
  useEnabledAcpHarnesses: () => () => Array<{ key: string; label: string }>
  /** The harness a workspace was last used with, from its draft-default record. */
}

let ports: SettingsAppPorts | undefined

export function configureSettingsAppPorts(value: SettingsAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Settings app ports are not configured")
  return ports
}

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: SettingsAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const useProviders = bind((ports) => ports.useProviders)
export const useGlobalSDK = bind((ports) => ports.useGlobalSDK)
export const useShellQueryOptions = bind((ports) => ports.useShellQueryOptions)
export const DialogConnectProvider = bind((ports) => ports.DialogConnectProvider)
export const DialogSelectProvider = bind((ports) => ports.DialogSelectProvider)
export const DialogCustomProvider = bind((ports) => ports.DialogCustomProvider)
export const verifyAIConnection = bind((ports) => ports.verifyAIConnection)
export const loadMachineLogins = bind((ports) => ports.loadMachineLogins)
export const useMachineLogin = bind((ports) => ports.useMachineLogin)

/** Not a `bind`: this port is a value, so it is read rather than called through. */
export function localHarnessChecks() {
  return required().localHarnessChecks
}

/** A value port too — the catalog is a list, not a call. */
export function terminalAgents() {
  return required().terminalAgents
}
export const getTerminalCommands = bind((ports) => ports.getTerminalCommands)
export const saveTerminalCommands = bind((ports) => ports.saveTerminalCommands)
export const defaultTerminalCommands = bind((ports) => ports.defaultTerminalCommands)
export const useModelVisibility = bind((ports) => ports.useModelVisibility)
export const loadHarnessModelOptions = bind((ports) => ports.loadHarnessModelOptions)
export const groupHarnessModels = bind((ports) => ports.groupHarnessModels)
export const formatKeybind = bind((ports) => ports.formatKeybind)
export const parseKeybind = bind((ports) => ports.parseKeybind)
export const useCommand = bind((ports) => ports.useCommand)
export const DialogConnectIntegration = bind((ports) => ports.DialogConnectIntegration)
export const ProviderConnectForm = bind((ports) => ports.ProviderConnectForm)
export const Link = bind((ports) => ports.Link)
export const useSandboxOnboardingFunnel = bind((ports) => ports.useSandboxOnboardingFunnel)
export const useSDK = bind((ports) => ports.useSDK)
export const useEnabledAcpHarnesses = bind((ports) => ports.useEnabledAcpHarnesses)
